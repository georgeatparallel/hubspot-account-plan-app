/** Domain-owned limits for the anonymous Parallel Search MCP integration. */
export const PARALLEL_SEARCH_DEFAULTS = Object.freeze({
  endpoint: "https://search.parallel.ai/mcp",
  userAgent:
    "hubspot-account-plan-app/0.0.1 (+https://github.com/MAN-Digital/hubspot-account-plan-app)",
  timeoutMs: 15_000,
  maxResults: 5,
  maxContentChars: 2000,
  maxResponseBytes: 256_000,
  confidence: 0.7,
});

export type ParallelSearchConfig = {
  timeoutMs: number;
  maxResults: number;
  maxContentChars: number;
};

/** Endpoint/auth cannot be overridden by tenant JSON; avoids arbitrary outbound targets. */
export function resolveParallelSearchConfig(settings: unknown): ParallelSearchConfig {
  const values = settings ?? {};
  if (typeof values !== "object" || Array.isArray(values))
    throw new Error("parallel invalid config");
  const record = values as Record<string, unknown>;
  const limits = {
    timeoutMs: [1, 30_000],
    maxResults: [1, 5],
    maxContentChars: [1, 2000],
  } as const;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(limits, key)) throw new Error("parallel invalid config");
  }
  const result: ParallelSearchConfig = {
    timeoutMs: PARALLEL_SEARCH_DEFAULTS.timeoutMs,
    maxResults: PARALLEL_SEARCH_DEFAULTS.maxResults,
    maxContentChars: PARALLEL_SEARCH_DEFAULTS.maxContentChars,
  };
  for (const key of Object.keys(limits) as (keyof ParallelSearchConfig)[]) {
    const value = record[key];
    if (value === undefined) continue;
    const [min, max] = limits[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new Error("parallel invalid config");
    }
    result[key] = value;
  }
  return result;
}

/** Saved disabled rows are deliberate configuration, never absence. */
export function hasSavedSearchConfiguration(providerNames: Iterable<string>): boolean {
  return Array.from(providerNames).some((name) => ["exa", "trigify", "parallel"].includes(name));
}
