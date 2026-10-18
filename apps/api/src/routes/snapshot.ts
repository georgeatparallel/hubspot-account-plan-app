import {
  createSnapshot,
  createStateFlags,
  hasSavedSearchConfiguration,
  type LlmProviderConfig,
  type ProviderConfig,
  type ThresholdConfig,
} from "@hap/config";
import type { Database } from "@hap/db";
import { Hono } from "hono";
import { createLlmAdapter, wrapWithGuards } from "../adapters/llm/factory.js";
import type { LlmAdapter } from "../adapters/llm-adapter.js";
import type { ProviderAdapter } from "../adapters/provider-adapter.js";
import {
  createExaSignalAdapters,
  createSignalAdapter,
  type SignalFactoryDeps,
  wrapSignalWithGuards,
} from "../adapters/signal/factory.js";
import { DEFAULT_THRESHOLDS, getLlmConfig, getProviderConfig } from "../lib/config-resolver.js";
import { TenantAccessRevokedError } from "../lib/hubspot-client.js";
import { getProcessRateLimiter } from "../lib/rate-limiter.js";
import type { CorrelationVariables } from "../middleware/correlation.js";
import type { TenantVariables } from "../middleware/tenant.js";
import {
  createHubSpotCompanyPropertyFetcher,
  createHubSpotContactFetcher,
  type HubSpotClientFactory,
} from "../services/crm-fetchers.js";
import type { CompanyPropertyFetcher } from "../services/eligibility.js";
import type { ContactFetcher } from "../services/people-selector.js";
import { assembleSnapshot } from "../services/snapshot-assembler.js";

type Vars = TenantVariables & CorrelationVariables & { portalId?: string };

/**
 * Normalize + validate companyId. Returns the trimmed value when valid, or
 * `null` when not. Caller must use the returned normalized value — never the
 * raw param — so downstream consumers never see leading/trailing whitespace.
 *
 * We accept the HubSpot numeric-string convention but stay permissive since
 * the CRM uses multiple record id shapes.
 */
function normalizeCompanyId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Snapshot route module.
 *
 * Mounted under `/api/snapshot` in `index.ts`. Full route: `POST /api/snapshot/:companyId`.
 *
 * Slice 3 pipeline:
 *   resolve adapters → if either missing, return `unconfigured` →
 *   eligibility gate → signal fetch → dominant signal → reason text
 *   → contact fetcher → ranked people → assembled Snapshot.
 *
 * Tenant safety: `tenantId` is ALWAYS sourced from `c.get('tenantId')` set by
 * the upstream tenant middleware. Body-provided tenantIds are ignored and the
 * assembler re-stamps evidence with the middleware-resolved tenantId.
 *
 * Adapter resolution: missing LLM setup, all saved search providers disabled,
 * or adapter construction failure means unconfigured. With no saved search
 * configuration, anonymous Parallel is the default. The route
 * short-circuits with `eligibilityState: "unconfigured"` instead of silently
 * serving mock data. Mock adapters remain only in `__tests__/` fixtures.
 */
export const snapshotRoutes = new Hono<{ Variables: Vars }>();

/** Reasonable bounds — guard against malformed or hostile DB rows. */
function isValidThresholds(t: ThresholdConfig): boolean {
  return (
    Number.isFinite(t.freshnessMaxDays) &&
    t.freshnessMaxDays >= 0 &&
    Number.isFinite(t.minConfidence) &&
    t.minConfidence >= 0 &&
    t.minConfidence <= 1
  );
}

/**
 * Fallback thresholds when the resolved signal provider row does not carry
 * valid thresholds. In Slice 3 this only fires when the signal resolution
 * DID find a real provider row (otherwise the route short-circuits to
 * unconfigured). Returns {@link DEFAULT_THRESHOLDS}.
 */
function fallbackThresholds(): ThresholdConfig {
  return DEFAULT_THRESHOLDS;
}

/**
 * Resolve the LLM adapter for a tenant.
 *
 * 1. Look up the tenant's default `llm_config` row via the resolver.
 * 2. If present, build the real provider adapter via {@link createLlmAdapter}
 *    and wrap with rate-limiter + observability.
 * 3. If absent or construction fails, return `null`. The caller short-circuits
 *    to an `eligibilityState: "unconfigured"` snapshot. Mock adapters are no
 *    longer used in route code (Slice 3).
 */
async function resolveLlmAdapter(
  db: Database,
  tenantId: string,
  correlationId: string | undefined,
): Promise<LlmAdapter | null> {
  let cfg: LlmProviderConfig | null = null;
  try {
    cfg = await getLlmConfig({ db }, { tenantId });
  } catch {
    cfg = null;
  }

  if (!cfg) {
    return null;
  }

  // M24: construction can throw on malformed config (e.g., provider=custom
  // with a missing endpoint_url, which is nullable in the schema). One
  // misconfigured tenant returns unconfigured — not a 500.
  let real: LlmAdapter;
  try {
    real = createLlmAdapter(cfg);
  } catch (err) {
    console.error("llm_adapter_construction_failed", {
      tenantId,
      provider: cfg.provider,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
    return null;
  }

  return wrapWithGuards(real, {
    tenantId,
    correlationId,
    rateLimiter: getProcessRateLimiter(),
  });
}

/**
 * Signal providers probed from `provider_config` rows.
 *
 * Stage A Task 7 changed resolution from FIRST-ENABLED-MATCH-WINS to
 * COMPOSE ALL ENABLED PROVIDERS: every provider in this list with an
 * enabled row is built into its own (possibly multi-adapter, e.g. Exa+News)
 * sub-adapter set, each wrapped individually with {@link wrapSignalWithGuards}
 * for per-source rate-limiting + observability, then the FULL set is fanned
 * out via {@link composeSignalAdapters}. A tenant with both Exa and Trigify
 * enabled gets evidence from both; a tenant with only one enabled is
 * unaffected (the composite of one provider's sub-adapters behaves exactly
 * as before).
 *
 * Thresholds precedence when multiple rows are enabled: the FIRST enabled
 * row (in this list's order) with VALID thresholds wins — later rows'
 * thresholds are ignored even if also valid. This mirrors the pre-Task-7
 * single-adapter precedence (Exa's thresholds always governed staleness/
 * confidence gating) so existing Exa-only tenants see byte-identical
 * eligibility behavior after this change.
 *
 * `news` is not a top-level provider slot — it runs as a secondary adapter
 * driven by the Exa row via {@link createExaSignalAdapters}.
 * `hubspot-enrichment` remains outside this search-provider probe list.
 * Parallel is synthesized only when all search-provider reads succeed and no
 * saved row exists; an explicit disabled row prevents the default.
 */
const REAL_SIGNAL_PROVIDERS = ["exa", "trigify", "parallel"] as const;

/**
 * Successful signal resolution — contains the adapter plus per-provider
 * config (allow/block lists, thresholds).
 */
type SignalResolution = {
  adapter: ProviderAdapter;
  allowList?: string[];
  blockList?: string[];
  thresholds?: ThresholdConfig;
};

/**
 * Compose N wrapped adapters into a single `ProviderAdapter` whose
 * `fetchSignals` runs all of them in parallel and flattens the resulting
 * evidence arrays.
 *
 * If any sub-adapter rejects, the composite rejects — matching the existing
 * single-adapter contract. The snapshot assembler catches that rejection and
 * marks the snapshot `degraded`.
 *
 * The composite's `name` mirrors the primary provider (e.g. `"exa"`) so
 * upstream logs and metrics don't suddenly see a new adapter name. Each
 * sub-adapter retains its own `name` inside the `wrapSignalWithGuards`
 * wrapper, so rate-limit buckets + observability log lines attribute
 * correctly per source (`exa` vs `news`).
 */
export function composeSignalAdapters(
  adapters: ProviderAdapter[],
  compositeName: string,
): ProviderAdapter {
  return {
    name: compositeName,
    async fetchSignals(tenantId, company, options) {
      const results = await Promise.all(
        adapters.map((a) =>
          options ? a.fetchSignals(tenantId, company, options) : a.fetchSignals(tenantId, company),
        ),
      );
      return results.flat();
    },
  };
}

/**
 * Build the sub-adapter set for ONE enabled provider config row, wrapped
 * individually with {@link wrapSignalWithGuards} for per-source rate-limiting
 * + observability.
 *
 * For the Exa row this fans out to both Exa search and the Exa news vertical
 * (NewsAdapter) via {@link createExaSignalAdapters}, gated by the row's
 * `settings.newsEnabled` flag. Every other provider (currently just Trigify)
 * resolves to exactly one adapter via {@link createSignalAdapter}. Returns
 * `[]` when the provider yields no adapters (e.g. Exa disabled mid-resolution)
 * so the caller can skip it without treating that as a hard failure for the
 * OTHER enabled providers.
 */
function buildWrappedSubAdapters(
  config: ProviderConfig,
  db: Database,
  tenantId: string,
  correlationId: string | undefined,
  deps?: SignalFactoryDeps,
): ProviderAdapter[] {
  const guardCtx = {
    tenantId,
    correlationId,
    rateLimiter: getProcessRateLimiter(),
  };
  if (config.name === "exa") {
    const subAdapters = createExaSignalAdapters(config, { ...deps, db, tenantId });
    return subAdapters.map((sub) => wrapSignalWithGuards(sub, guardCtx));
  }
  const real = createSignalAdapter(config, { ...deps, db, tenantId });
  return [wrapSignalWithGuards(real, guardCtx)];
}

/**
 * Resolve the signal adapter for a tenant.
 *
 * Stage A Task 7: probes `provider_config` for EVERY provider in
 * {@link REAL_SIGNAL_PROVIDERS} (not just the first enabled match) and
 * COMPOSES all of them into one `ProviderAdapter` via
 * {@link composeSignalAdapters} — a tenant with both Exa and Trigify enabled
 * gets evidence from both, fanned out in parallel exactly like the existing
 * Exa+News composition. Returns `null` when NO enabled provider row exists
 * (across the whole list) or every enabled provider's adapter construction
 * fails; the caller short-circuits to `eligibilityState: "unconfigured"`.
 *
 * A single provider's construction failure does NOT block the others — it
 * is logged and that provider is skipped, mirroring the pre-Task-7
 * "treat construction failure as unconfigured" posture but now scoped
 * per-provider instead of aborting the whole resolution.
 *
 * Thresholds precedence: the FIRST enabled row (in `REAL_SIGNAL_PROVIDERS`
 * order) with VALID thresholds wins. This keeps Exa-only tenants on
 * byte-identical eligibility behavior post-Task-7 (Exa's thresholds already
 * governed staleness/confidence gating before Trigify existed).
 */
export async function resolveSignalAdapter(
  db: Database,
  tenantId: string,
  correlationId: string | undefined,
  deps?: SignalFactoryDeps,
): Promise<SignalResolution | null> {
  const enabledConfigs: ProviderConfig[] = [];
  const savedProviders: string[] = [];
  let resolutionFailed = false;
  for (const providerName of REAL_SIGNAL_PROVIDERS) {
    try {
      const cfg = await getProviderConfig({ db }, { tenantId, providerName });
      if (cfg) savedProviders.push(providerName);
      if (cfg?.enabled) {
        enabledConfigs.push(cfg);
      }
    } catch {
      // An unreadable saved choice is not evidence of absent configuration.
      resolutionFailed = true;
    }
  }

  if (!resolutionFailed && !hasSavedSearchConfiguration(savedProviders)) {
    enabledConfigs.push({
      name: "parallel",
      enabled: true,
      apiKeyRef: "",
      thresholds: DEFAULT_THRESHOLDS,
    });
  }
  if (enabledConfigs.length === 0) return null;

  // Construction can throw — e.g., required tenant-scoped deps are missing,
  // or a provider config row has a non-null field that's nullable in the
  // schema. A per-provider failure is logged and that provider is skipped
  // rather than aborting resolution for every enabled provider.
  const allSubAdapters: ProviderAdapter[] = [];
  let firstValidThresholds: ThresholdConfig | undefined;
  let firstAllowList: string[] | undefined;
  let firstBlockList: string[] | undefined;

  for (const config of enabledConfigs) {
    try {
      const wrapped = buildWrappedSubAdapters(config, db, tenantId, correlationId, deps);
      if (wrapped.length === 0) continue;
      allSubAdapters.push(...wrapped);
      if (firstValidThresholds === undefined && isValidThresholds(config.thresholds)) {
        firstValidThresholds = config.thresholds;
        firstAllowList = config.allowList;
        firstBlockList = config.blockList;
      }
    } catch (err) {
      console.error("signal_adapter_construction_failed", {
        tenantId,
        provider: config.name,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      });
    }
  }

  if (allSubAdapters.length === 0) {
    return null;
  }

  // Composite name mirrors the first enabled provider so existing logs/metrics
  // that key on a single adapter name keep working when only one provider is
  // enabled (the common case today). When multiple providers compose, this
  // is still a stable, deterministic choice (list order), not "whichever
  // resolved last".
  const compositeName = enabledConfigs[0]?.name ?? "composed";
  const adapter = composeSignalAdapters(allSubAdapters, compositeName);

  return {
    adapter,
    allowList: firstAllowList,
    blockList: firstBlockList,
    thresholds: firstValidThresholds,
  };
}

/**
 * V1 fixture property fetchers. ONLY reachable outside production (see
 * {@link resolvePropertyFetcher}) via the `?eligibility=` query param, so QA
 * fixtures / dev convenience keep working. Production ALWAYS uses the real
 * HubSpot-backed fetcher — this override is completely inert there
 * regardless of what the caller passes.
 */
const eligiblePropertyFetcher: CompanyPropertyFetcher = async () => true;
const ineligiblePropertyFetcher: CompanyPropertyFetcher = async () => false;
const unconfiguredPropertyFetcher: CompanyPropertyFetcher = async () => undefined;

type EligibilityMode = "eligible" | "ineligible" | "unconfigured";
const ELIGIBILITY_MODES: readonly EligibilityMode[] = ["eligible", "ineligible", "unconfigured"];
function isEligibilityMode(v: unknown): v is EligibilityMode {
  return typeof v === "string" && (ELIGIBILITY_MODES as readonly string[]).includes(v);
}

function pickFixturePropertyFetcher(mode: EligibilityMode): CompanyPropertyFetcher {
  switch (mode) {
    case "ineligible":
      return ineligiblePropertyFetcher;
    case "unconfigured":
      return unconfiguredPropertyFetcher;
    case "eligible":
      return eligiblePropertyFetcher;
  }
}

/**
 * Resolve the {@link CompanyPropertyFetcher} the snapshot route should use.
 *
 * Production (`NODE_ENV === "production"`) ALWAYS returns the real
 * HubSpot-backed fetcher — the `?eligibility=` fixture override never fires
 * there, even if a caller supplies the query param. Outside production, an
 * explicit `eligibilityParam` still selects a fixture fetcher (QA/dev
 * convenience, matching pre-Task-8 behavior); when absent, the real fetcher
 * is used so local/dev testing against a real HubSpot test portal works
 * without the query param.
 *
 * Exported (like {@link composeSignalAdapters}) so this env-gate boundary is
 * unit-testable without spinning up the full Hono app + auth stack.
 */
export function resolvePropertyFetcher(
  db: Database,
  eligibilityParam: string | undefined,
  clientFactory?: HubSpotClientFactory,
): CompanyPropertyFetcher {
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction && isEligibilityMode(eligibilityParam)) {
    return pickFixturePropertyFetcher(eligibilityParam);
  }
  return createHubSpotCompanyPropertyFetcher({ db, clientFactory });
}

/**
 * Resolve the {@link ContactFetcher} the snapshot route should use.
 *
 * Always the real HubSpot-backed fetcher — there is no fixture contact
 * override in the resolver (the three-hardcoded-contacts fixture is gone).
 * Kept as its own function (rather than inlined) so route code stays a thin
 * caller and the resolution is independently unit-testable.
 */
export function resolveContactFetcher(
  db: Database,
  clientFactory?: HubSpotClientFactory,
): ContactFetcher {
  return createHubSpotContactFetcher({ db, clientFactory });
}

function isTenantAccessRevokedError(error: unknown): boolean {
  return (
    error instanceof TenantAccessRevokedError ||
    (error instanceof Error && error.name === "TenantAccessRevokedError")
  );
}

snapshotRoutes.post("/:companyId", async (c) => {
  const rawCompanyId = c.req.param("companyId") ?? "";
  const decoded = decodeURIComponent(rawCompanyId);

  const companyId = normalizeCompanyId(decoded);
  if (!companyId) {
    return c.json({ error: "invalid_company_id" }, 400);
  }

  // Testability hook: reserved id for the 404 path.
  if (companyId === "missing-company") {
    return c.json({ error: "not_found" }, 404);
  }

  const tenantId = c.get("tenantId");
  if (!tenantId) {
    // Defensive — tenantMiddleware should have already returned 401.
    return c.json({ error: "unauthorized" }, 401);
  }

  const eligibilityParam = c.req.query("eligibility");

  try {
    const db = c.get("db");
    if (!db) {
      throw new Error("tenant-scoped db handle missing from request context");
    }
    const correlationId = c.get("correlationId");
    const llmAdapter = await resolveLlmAdapter(db, tenantId, correlationId);
    const signal = await resolveSignalAdapter(db, tenantId, correlationId);

    // Short-circuit: if either adapter could not be resolved, the tenant's
    // provider configuration is incomplete. Return an explicit unconfigured
    // snapshot instead of silently serving mock data.
    if (!llmAdapter || !signal) {
      const unconfiguredSnapshot = createSnapshot(tenantId, {
        companyId,
        eligibilityState: "unconfigured",
        reasonToContact: undefined,
        people: [],
        evidence: [],
        stateFlags: createStateFlags({ empty: true }),
        createdAt: new Date(),
      });
      return c.json(unconfiguredSnapshot, 200);
    }

    const thresholds = signal.thresholds ?? fallbackThresholds();
    const snapshot = await assembleSnapshot(
      {
        db,
        providerAdapter: signal.adapter,
        llmAdapter,
        propertyFetcher: resolvePropertyFetcher(db, eligibilityParam),
        contactFetcher: resolveContactFetcher(db),
        thresholds,
        allowList: signal.allowList,
        blockList: signal.blockList,
        // M13: trace continuity — the assembler threads this into the
        // next-move observability ctx so the whole request chain shares
        // one correlation ID in logs.
        correlationId,
      },
      { tenantId, companyId, signal: c.req.raw.signal },
    );
    return c.json(snapshot, 200);
  } catch (err) {
    if (isTenantAccessRevokedError(err)) {
      console.warn("snapshot_route.tenant_access_revoked", {
        tenantId,
        companyId,
        eligibilityParam,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          error: "tenant_access_revoked",
          detail: "hubspot access revoked or app uninstalled for tenant",
        },
        401,
      );
    }
    // Log a stable error CLASS + safe request context. Never the raw
    // err.message — external clients can smuggle URLs / tenant data / auth
    // material into Error.message and we don't want that in shared logs.
    console.error("snapshot_route_error", {
      tenantId,
      companyId,
      eligibilityParam,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
    return c.json({ error: "internal_error" }, 500);
  }
});

export default snapshotRoutes;
