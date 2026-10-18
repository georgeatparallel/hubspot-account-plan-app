/**
 * Signal adapter factory (Slice 2 Step 9).
 *
 * Resolves a {@link ProviderAdapter} from a tenant-scoped {@link ProviderConfig}.
 * Mirrors {@link ../llm/factory.createLlmAdapter} — Slice 3 should not have to
 * learn two different patterns.
 *
 * Decryption: the config-resolver
 * ({@link ../../lib/config-resolver.getProviderConfig}) already decrypts
 * `api_key_encrypted` into `apiKeyRef` before returning, so this factory just
 * reads plaintext from the config. The factory never touches ciphertext.
 *
 * Provider status:
 *  - `exa` → real {@link ./exa.ExaAdapter}. The Exa provider row also drives
 *    the {@link ./news.NewsAdapter} via the shared API key — see
 *    {@link createExaSignalAdapters}. News is no longer a top-level provider
 *    slot.
 *  - `hubspot-enrichment` → real per-tenant HubSpot CRM enrichment
 *    backed by the OAuth-aware `HubSpotClient`.
 *
 * Guardrails: {@link wrapSignalWithGuards} returns a new {@link ProviderAdapter}
 * whose `fetchSignals()` is rate-limited (token bucket, per-tenant × provider)
 * and wrapped with {@link withObservability} for structured logs + metrics +
 * correlation-ID propagation. Sibling to the Step 8 LLM guard wrapper.
 */

import type { Evidence, ProviderConfig } from "@hap/config";
import { HubSpotClient, type HubSpotClientOptions } from "../../lib/hubspot-client.js";
import { type ObservabilityContext, withObservability } from "../../lib/observability.js";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  type RateLimitConfig,
  type RateLimiter,
} from "../../lib/rate-limiter.js";
import type {
  ProviderAdapter,
  ProviderCompanyContext,
  ProviderFetchOptions,
} from "../provider-adapter.js";
import { ExaAdapter } from "./exa.js";
import { HubSpotEnrichmentAdapter } from "./hubspot-enrichment.js";
import { NewsAdapter } from "./news.js";
import { ParallelAdapter } from "./parallel.js";
import { createTrigifyStoreAdapter } from "./trigify.js";

/** Optional constructor-injection hooks for tests and non-default wiring. */
export interface SignalFactoryDeps {
  /** Override global `fetch` (cassette tests). Propagated to the adapter. */
  fetch?: typeof fetch;
  db?: HubSpotClientOptions["db"];
  tenantId?: string;
  hubspotClient?: HubSpotClient;
}

/**
 * Error thrown when a wrapped adapter call is denied by the rate limiter.
 * Carries the limiter's `retryAfterMs` so callers can surface an HTTP 429
 * with `Retry-After`. Sibling to {@link ../llm/factory.LlmRateLimitedError}.
 */
export class SignalRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("signal request rate-limited");
    this.name = "SignalRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Resolve a {@link ProviderAdapter} from a tenant's signal provider config.
 *
 * The `config.apiKeyRef` field is already plaintext here — the config-resolver
 * decrypts via {@link ../../lib/encryption.decryptProviderKey} before caching.
 * Callers therefore never see ciphertext.
 *
 * @throws Error when `config.name` is not one of the three supported signal
 *   providers. This is defense-in-depth: a malformed DB row ultimately
 *   escaping the resolver should fail loudly, not silently.
 */
export function createSignalAdapter(
  config: ProviderConfig,
  deps?: SignalFactoryDeps,
): ProviderAdapter {
  const fetchImpl = deps?.fetch;
  switch (config.name) {
    case "exa":
      return new ExaAdapter({
        apiKey: config.apiKeyRef,
        fetch: fetchImpl,
      });
    case "parallel": {
      if (!deps?.tenantId) throw new Error("parallel requires tenantId");
      const client =
        deps.hubspotClient ??
        (() => {
          if (!deps.db) throw new Error("parallel requires tenant-scoped db");
          return new HubSpotClient({
            tenantId: deps.tenantId as string,
            db: deps.db,
            fetch: fetchImpl,
          });
        })();
      return new ParallelAdapter({
        tenantId: deps.tenantId,
        client,
        fetch: fetchImpl,
        config: config.settings,
      });
    }
    case "hubspot-enrichment": {
      const client =
        deps?.hubspotClient ??
        (() => {
          if (!deps?.db || !deps.tenantId) {
            throw new Error(
              "createSignalAdapter: hubspot-enrichment requires deps.tenantId and deps.db when no HubSpotClient is injected.",
            );
          }
          return new HubSpotClient({
            tenantId: deps.tenantId,
            db: deps.db,
            fetch: fetchImpl,
          });
        })();
      return new HubSpotEnrichmentAdapter(client);
    }
    case "trigify": {
      if (!deps?.db || !deps.tenantId) {
        throw new Error("createSignalAdapter: trigify requires deps.tenantId and deps.db.");
      }
      return createTrigifyStoreAdapter(deps.db, config.settings);
    }
    default: {
      const name = (config as { name: string }).name;
      throw new Error(`Unknown signal provider: ${name}`);
    }
  }
}

/**
 * Build the full set of signal adapters driven by the Exa provider row.
 *
 * News is no longer a top-level provider slot — it shares Exa's credential
 * and runs as a secondary adapter. Gating rules:
 *
 *  - `config.enabled === false` → returns `[]`. Neither Exa main nor News.
 *  - `config.settings.newsEnabled === false` → returns `[ExaAdapter]` only.
 *  - Otherwise (enabled, `newsEnabled` unset or `true`) → returns
 *    `[ExaAdapter, NewsAdapter]` both wired to the same API key.
 *
 * The caller is responsible for wrapping each returned adapter with
 * {@link wrapSignalWithGuards} per-tenant before handing them to the
 * snapshot assembler.
 */
export function createExaSignalAdapters(
  config: ProviderConfig,
  deps?: SignalFactoryDeps,
): ProviderAdapter[] {
  if (config.name !== "exa") {
    throw new Error(`createExaSignalAdapters expects an exa provider config; got '${config.name}'`);
  }
  if (!config.enabled) {
    return [];
  }

  const fetchImpl = deps?.fetch;
  const adapters: ProviderAdapter[] = [
    new ExaAdapter({ apiKey: config.apiKeyRef, fetch: fetchImpl }),
  ];

  const newsEnabled =
    config.settings && typeof config.settings === "object"
      ? (config.settings as Record<string, unknown>).newsEnabled
      : undefined;

  // Default: news on. Only `newsEnabled === false` turns it off.
  if (newsEnabled !== false) {
    adapters.push(new NewsAdapter({ apiKey: config.apiKeyRef, fetch: fetchImpl }));
  }

  return adapters;
}

/** Context required to wrap an adapter call with rate-limiter + observability. */
export interface SignalGuardContext {
  tenantId: string;
  correlationId?: string;
  rateLimiter: RateLimiter;
  rateLimitConfig?: RateLimitConfig;
}

/**
 * Wrap a {@link ProviderAdapter} so that every `fetchSignals()` call:
 *  1. acquires a token from `ctx.rateLimiter` keyed on `(tenantId, provider)`;
 *     throws {@link SignalRateLimitedError} when denied.
 *  2. runs inside {@link withObservability} — a structured enter/exit log
 *     line with correlation ID + latency. `operation` is `"signal.fetch"`.
 *
 * The returned adapter reuses the inner adapter's `name` so downstream
 * consumers (the snapshot assembler, metrics sinks) can't tell the guard
 * wrapper exists. That's deliberate — the guard is a cross-cutting concern,
 * not a new adapter family.
 */
export function wrapSignalWithGuards(
  adapter: ProviderAdapter,
  ctx: SignalGuardContext,
): ProviderAdapter {
  const rateLimitConfig = ctx.rateLimitConfig ?? DEFAULT_RATE_LIMIT_CONFIG;

  return {
    name: adapter.name,
    async fetchSignals(
      tenantId: string,
      company: ProviderCompanyContext,
      options?: ProviderFetchOptions,
    ): Promise<Evidence[]> {
      // Tenant binding: ctx.tenantId is the authoritative tenant (the wrapper
      // is built per-tenant in resolveSignalAdapter). The `tenantId` parameter
      // on the ProviderAdapter interface must match. We assert here because a
      // mismatch would attribute rate-limit quota / observability logs to the
      // wrong tenant — a silent cross-tenant bleed.
      if (tenantId !== ctx.tenantId) {
        throw new Error(`signal wrap: tenantId mismatch (param=${tenantId}, ctx=${ctx.tenantId})`);
      }

      const obsCtx: ObservabilityContext = {
        tenantId: ctx.tenantId,
        provider: adapter.name,
        operation: "signal.fetch",
        correlationId: ctx.correlationId,
      };

      // withObservability wraps the ENTIRE call including the rate-limit
      // check so that 429-class denials still emit a structured log line
      // (fix for cubic review P2: rate-limit bypass of observability).
      return withObservability(async () => {
        const { allowed, retryAfterMs } = await ctx.rateLimiter.acquire(
          ctx.tenantId,
          adapter.name,
          rateLimitConfig,
        );
        if (!allowed) {
          throw new SignalRateLimitedError(retryAfterMs ?? 0);
        }
        return options
          ? adapter.fetchSignals(ctx.tenantId, company, options)
          : adapter.fetchSignals(ctx.tenantId, company);
      }, obsCtx);
    },
  };
}
