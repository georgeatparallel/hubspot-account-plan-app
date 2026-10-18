/**
 * Public surface of `@hap/config`.
 *
 * Consumers: `@hap/api`, `@hap/hubspot-extension`, `@hap/validators`, tests.
 *
 * - `domain-types`: wire-level types (Snapshot, Evidence, Person, StateFlags,
 *   EligibilityState, ThresholdConfig, ProviderConfig, LlmProviderConfig,
 *   LlmProviderType, TenantSettings, TenantConfig).
 * - `factories`: tenant-aware constructors + 8 distinct QA fixtures.
 * - `trigify-signal-types`: the Trigify 16-signal taxonomy constant
 *   (trigger-code -> class/tier/level map, derived set, monitoring types).
 */
export * from "./domain-types.js";
export * from "./env.js";
export * from "./factories.js";
export * from "./llm-catalog.js";
export * from "./parallel-search.js";
export * from "./trigify-signal-types.js";
