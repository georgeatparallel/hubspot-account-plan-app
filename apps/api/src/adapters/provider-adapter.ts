/**
 * Provider adapter interface (signals / evidence sources).
 *
 * Slice 3 ships the real signal factory plus the `exa`, `news`, and
 * `hubspot-enrichment` adapters. The Slice 1
 * {@link ./mock-signal-adapter} remains test-only fixture infrastructure.
 *
 * Contract expectations for ALL implementations:
 *  - `fetchSignals` MUST tag every returned Evidence with the caller-supplied
 *    `tenantId` so cross-tenant leakage is impossible at this boundary.
 *  - Adapters MUST be config-driven. No hardcoded provider keys, thresholds,
 *    or install-time assumptions live in adapter code — those are resolved via
 *    `config-resolver` using per-tenant `provider_config` rows.
 */

import type { Evidence } from "@hap/config";

export type ProviderCompanyContext = {
  companyId: string;
  companyName?: string;
  domain?: string;
};

export type ProviderFetchOptions = { signal?: AbortSignal };

export interface ProviderAdapter {
  /** Stable identifier — used for logging, config lookup, and fixture names. */
  readonly name: string;
  /**
   * Fetch zero or more Evidence rows for the given company.
   *
   * Implementations MUST NOT throw on "no results" — return `[]` instead.
   * Transport errors MAY throw; the caller (signals service in Slice 2)
   * catches and marks the snapshot `degraded`.
   */
  fetchSignals(
    tenantId: string,
    company: ProviderCompanyContext,
    options?: ProviderFetchOptions,
  ): Promise<Evidence[]>;
}
