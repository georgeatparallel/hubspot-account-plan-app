/**
 * Domain types for the HubSpot Signal-First Account Workspace.
 *
 * These types represent the SHAPE OF THE WIRE between API, domain, and
 * extension. They intentionally differ from `@hap/db` row types:
 * - camelCase field names
 * - `Date` objects (not ISO strings or pg timestamp values)
 * - parsed jsonb shapes
 *
 * Map between DB row types and these domain types in mapper modules; do not
 * re-export DB row types as the public domain model.
 */

/**
 * Top-level eligibility for an account's snapshot.
 *
 * - `eligible`: the tenant has permission and the account qualifies
 * - `ineligible`: account does not qualify (e.g. `hs_is_target_account` false)
 * - `unconfigured`: tenant has not finished provider/threshold setup
 */
export type EligibilityState = "eligible" | "ineligible" | "unconfigured";

/**
 * Orthogonal render flags that influence how the extension surfaces a snapshot.
 *
 * Multiple flags can be true simultaneously (e.g. `stale` + `lowConfidence`),
 * but fixtures are crafted so each QA fixture has a DISTINCT combination.
 *
 * - `stale`: evidence is older than `ThresholdConfig.freshnessMaxDays`
 * - `degraded`: one or more source adapters failed or returned partial data
 * - `lowConfidence`: `trustScore` below configured threshold
 * - `ineligible`: mirrors `EligibilityState === 'ineligible'` for UI convenience
 * - `restricted`: contains restricted evidence that must NEVER be shown or summarized
 * - `empty`: no credible reason to contact this account right now
 */
export type StateFlags = {
  stale: boolean;
  degraded: boolean;
  lowConfidence: boolean;
  ineligible: boolean;
  restricted: boolean;
  empty: boolean;
};

/**
 * Trigify's observable-vs-derived signal classification.
 *
 * - `observable`: a real event with a citable evidence record (post, job ad,
 *   role change). May be asserted in copy.
 * - `derived`: a Trigify inference (buying-window, influence, expansion)
 *   with no single citable event. Prioritization-only — MUST NEVER be
 *   asserted in copy, and a derived signal alone can never cross the send
 *   threshold (see `references/signal-types.md`).
 */
export type SignalClass = "observable" | "derived";

/**
 * Trigify signal strength tier: A (strongest) down to C (weakest).
 */
export type SignalTier = "A" | "B" | "C";

/**
 * Single piece of evidence supporting a reason-to-contact.
 *
 * `isRestricted=true` evidence must be filtered out before any UI rendering
 * or LLM summarization.
 *
 * The `signalType`/`signalClass`/`tier`/`copyAssertable`/`evidenceUrl`/
 * `evidenceDate` fields are OPTIONAL and ADDITIVE (Stage A Task 2) —
 * introduced for the Trigify signal integration. Existing Exa/News evidence
 * never sets them and keeps working unchanged. `copyAssertable` is the
 * load-bearing field: any evidence with `copyAssertable === false` (i.e.
 * every Trigify `derived` signal) must never be selected as the dominant
 * signal in `extractDominantSignal` (see
 * `apps/api/src/services/reason-generator.ts`), independent of confidence.
 */
export type Evidence = {
  id: string;
  tenantId: string;
  source: string;
  timestamp: Date;
  /** 0..1 confidence score from the source adapter. */
  confidence: number;
  content: string;
  isRestricted: boolean;
  /** Trigify (or future signal-typed provider) trigger code, e.g. "T_Role_Change". */
  signalType?: string;
  /** observable = may be asserted in copy; derived = prioritization-only, never asserted. */
  signalClass?: SignalClass;
  /** Signal strength tier: A (strongest) .. C (weakest). */
  tier?: SignalTier;
  /**
   * Whether this evidence may be asserted as a fact in generated copy.
   * Defaults to "yes" semantics for legacy (Exa/News) evidence that never
   * sets this field — the guard in `extractDominantSignal` only excludes
   * evidence where this is explicitly `false`.
   */
  copyAssertable?: boolean;
  /** Clickable URL to the underlying observable event (post, job ad, profile). */
  evidenceUrl?: string;
  /** Date the underlying event occurred (distinct from `timestamp`, the ingestion time). */
  evidenceDate?: Date;
  /**
   * Resolved HubSpot contact id when this evidence is a person-level signal
   * (e.g. a Trigify signal tied to a specific LinkedIn profile that was
   * matched to a CRM contact). Undefined when the signal is company-level or
   * the person could not be resolved to a contact — never fabricated.
   * `people-selector.rankContacts` ranks the contact matching this id first
   * when present (Stage A Task 8).
   */
  hsContactId?: string;
};

/**
 * Contact person associated with the account snapshot.
 *
 * V1 supports 0..3 people per snapshot. Never fabricate filler contacts.
 */
export type Person = {
  id: string;
  name: string;
  title?: string;
  reasonToTalk: string;
  /** IDs of `Evidence` rows that support this person's reason-to-talk. */
  evidenceRefs: string[];
};

/**
 * Maximum allowed length (characters) of a `Snapshot.nextMove` string.
 *
 * The backend truncates LLM output to this cap in
 * `apps/api/src/services/next-move.ts` and the Zod validator enforces the
 * same bound, so frontend + backend cannot drift on the wire contract.
 */
export const MAX_NEXT_MOVE_CHARS = 280;

/**
 * Shape of a rendered account snapshot for a given tenant + company.
 *
 * A `Snapshot` is the primary wire-level contract between API and extension.
 */
export type Snapshot = {
  tenantId: string;
  companyId: string;
  eligibilityState: EligibilityState;
  reasonToContact?: string;
  people: Person[];
  evidence: Evidence[];
  stateFlags: StateFlags;
  /** 0..1 aggregate trust score; undefined when not computed. */
  trustScore?: number;
  /**
   * Optional one-line recommended next action (Slice 2 Step 13). Generated
   * only for eligible snapshots; null/undefined for restricted, ineligible,
   * or empty. Length is capped at {@link MAX_NEXT_MOVE_CHARS}.
   */
  nextMove?: string;
  createdAt: Date;
};

/**
 * Threshold configuration applied per tenant/provider.
 */
export type ThresholdConfig = {
  freshnessMaxDays: number;
  /** 0..1 minimum confidence for evidence to count toward eligibility. */
  minConfidence: number;
};

/**
 * Supported LLM provider families. Customers bring their own API keys.
 */
export type LlmProviderType = "anthropic" | "openai" | "gemini" | "openrouter" | "custom";

/**
 * Tenant-specific LLM provider configuration.
 *
 * `apiKeyRef` is an OPAQUE REFERENCE resolved via the encryption layer.
 * It is never a plaintext key.
 */
export type LlmProviderConfig = {
  provider: LlmProviderType;
  model: string;
  apiKeyRef: string;
  /** Required for `custom` OpenAI-compatible endpoints. */
  endpointUrl?: string;
};

/**
 * Non-LLM provider configuration (e.g. Exa, HubSpot API surfaces, enrichment).
 */
export type ProviderConfig = {
  name: string;
  enabled: boolean;
  apiKeyRef: string;
  thresholds: ThresholdConfig;
  /**
   * Optional per-provider allow-list of source domains. When non-empty,
   * only evidence whose `source` matches one of these entries (subdomain
   * match via `endsWith`) flows past the hygiene stage.
   */
  allowList?: string[];
  /**
   * Optional per-provider block-list of source domains. When non-empty,
   * any evidence whose `source` matches one of these entries (subdomain
   * match via `endsWith`) is dropped. Block always wins over allow.
   */
  blockList?: string[];
  /**
   * Optional per-provider JSONB settings bag. Used by the Exa provider to
   * gate the news sub-adapter via `newsEnabled` without exposing News as a
   * top-level provider slot. Absent / undefined = default behavior.
   */
  settings?: Record<string, unknown>;
};

/**
 * Aggregated tenant settings: defaults + provider list.
 */
export type TenantSettings = {
  defaultLlmProvider?: LlmProviderType;
  thresholds: ThresholdConfig;
  providers: ProviderConfig[];
};

/**
 * Tenant configuration surface. `settings` is optional so legacy callers
 * that only need `{ tenantId, hubspotPortalId }` continue to compile.
 */
export type TenantConfig = {
  tenantId: string;
  hubspotPortalId: string;
  settings?: TenantSettings;
};

/**
 * Signal providers exposed in the settings surface.
 *
 * The News vertical is driven by the Exa provider at adapter-factory time
 * (same API key, separate `NewsAdapter`), so `news` is intentionally NOT in
 * this union — it is not a user-configurable provider slot.
 *
 * `trigify` follows the same shape as `exa` (a real user-entered/rotatable
 * API key) — see {@link SettingsProviderUpdate}. It backs the trigify
 * `provider_config` row that `TrigifyStoreAdapter` and `services/trigify/poller.ts`
 * resolve at read/poll time.
 */
export type SettingsSignalProviderName = "exa" | "hubspot-enrichment" | "trigify" | "parallel";

/**
 * Presence-only provider settings state returned by the settings API.
 *
 * Secrets are never returned in plaintext. `hasApiKey` reports whether a
 * provider currently has a stored encrypted key.
 */
export type SettingsProviderState = {
  enabled: boolean;
  hasApiKey: boolean;
};

/**
 * Wire shape returned by the settings API for signal provider sections.
 *
 * Keys are camelCase for ergonomic JSON/UI access; provider identifiers can
 * still use hyphenated names elsewhere when treated as scalar values.
 */
export type SettingsSignalProviders = {
  parallel: SettingsProviderState;
  exa: SettingsProviderState;
  hubspotEnrichment: SettingsProviderState;
  trigify: SettingsProviderState;
};

/**
 * Settings API read model for the current tenant.
 */
export type SettingsResponse = {
  tenantId: string;
  signalProviders: SettingsSignalProviders;
  llm: {
    provider: LlmProviderType | null;
    model: string;
    endpointUrl?: string;
    hasApiKey: boolean;
  };
  eligibility: {
    propertyName: string;
  };
  thresholds: ThresholdConfig;
};

/**
 * Partial update for a single signal provider from the settings UI.
 *
 * `apiKey` is replace-only. Blank input is treated as "preserve existing";
 * explicit deletion, if supported, uses `clearApiKey`.
 */
export type SettingsProviderUpdate = {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
};

/**
 * HubSpot enrichment is OAuth-backed, so its update leaf has no `apiKey` or
 * `clearApiKey` field. A dedicated type prevents the UI/wire contract from
 * silently accepting a fake API key that would never be used.
 */
export type SettingsHubspotEnrichmentUpdate = {
  enabled?: boolean;
};

export type SettingsSignalProviderUpdates = {
  /** Anonymous Parallel MCP supports enable/disable only. */
  parallel?: { enabled?: boolean };
  exa?: SettingsProviderUpdate;
  hubspotEnrichment?: SettingsHubspotEnrichmentUpdate;
  /** Same shape as `exa` — trigify is a real user-entered/rotatable API key. */
  trigify?: SettingsProviderUpdate;
};

/**
 * Body of `POST /api/settings/test-connection` — discriminated union on
 * `target`. Draft-key and saved-key modes are mutually exclusive (XOR
 * enforced by the Zod validator in `@hap/validators`).
 *
 * `endpointUrl` is REQUIRED when `provider === "custom"` and MUST be HTTPS.
 * The backend additionally enforces SSRF guards against loopback, link-local,
 * private-range, and cloud-metadata hostnames.
 */
export type TestConnectionLlmBody = {
  target: "llm";
  provider: LlmProviderType;
  model: string;
  endpointUrl?: string;
  apiKey?: string;
  useSavedKey?: true;
};

export type TestConnectionExaBody = {
  target: "exa";
  apiKey?: string;
  useSavedKey?: true;
};

export type TestConnectionBody = TestConnectionLlmBody | TestConnectionExaBody;

/**
 * Narrow error codes returned by the test-connection service. Vendor error
 * bodies are NEVER forwarded verbatim — all vendor failures collapse to one
 * of these codes plus a short sanitized human-readable `message`.
 */
export type TestConnectionErrorCode =
  | "auth"
  | "model"
  | "endpoint"
  | "network"
  | "rate_limit"
  | "unknown";

export type TestConnectionResponse =
  | { ok: true; latencyMs: number; providerEcho?: { model?: string } }
  | { ok: false; code: TestConnectionErrorCode; message: string };

/**
 * Partial update payload for tenant settings writes.
 */
export type SettingsUpdate = {
  signalProviders?: SettingsSignalProviderUpdates;
  llm?: {
    provider?: LlmProviderType | null;
    model?: string;
    endpointUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  };
  eligibility?: {
    propertyName?: string;
  };
  thresholds?: Partial<ThresholdConfig>;
};
