import type {
  SettingsResponse,
  SettingsSignalProviderName,
  SettingsUpdate,
  TestConnectionBody,
  TestConnectionResponse,
} from "@hap/config";
import { z } from "zod";
import { llmProviderTypeSchema, thresholdConfigSchema } from "./snapshot.js";

function preserveBlankSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const settingsSignalProviderNameSchema = z.enum([
  "exa",
  "hubspot-enrichment",
  "trigify",
  "parallel",
]) satisfies z.ZodType<SettingsSignalProviderName>;

export const settingsProviderStateSchema = z
  .object({
    enabled: z.boolean(),
    hasApiKey: z.boolean(),
  })
  .strict();

export const settingsResponseSchema = z
  .object({
    tenantId: z.string().min(1),
    signalProviders: z
      .object({
        parallel: settingsProviderStateSchema,
        exa: settingsProviderStateSchema,
        hubspotEnrichment: settingsProviderStateSchema,
        trigify: settingsProviderStateSchema,
      })
      .strict(),
    llm: z
      .object({
        provider: llmProviderTypeSchema.nullable(),
        model: z.string(),
        endpointUrl: z.string().url().optional(),
        hasApiKey: z.boolean(),
      })
      .strict(),
    eligibility: z
      .object({
        propertyName: z.string().min(1),
      })
      .strict(),
    thresholds: thresholdConfigSchema,
  })
  .strict() satisfies z.ZodType<SettingsResponse>;

const providerUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiKey: z.preprocess(preserveBlankSecret, z.string().min(1).optional()),
    clearApiKey: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.clearApiKey && value.apiKey), {
    message: "clearApiKey cannot be combined with apiKey",
    path: ["clearApiKey"],
  });

// HubSpot enrichment is OAuth-backed. Its update leaf must NOT accept
// `apiKey` / `clearApiKey` — the previous UI field was cosmetic and
// misleading. `.strict()` makes any stray `apiKey` submission fail with 400.
const hubspotEnrichmentUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const llmUpdateSchema = z
  .object({
    provider: llmProviderTypeSchema.nullable().optional(),
    model: z.string().min(1).optional(),
    endpointUrl: z.preprocess(preserveBlankSecret, z.string().url().optional()),
    apiKey: z.preprocess(preserveBlankSecret, z.string().min(1).optional()),
    clearApiKey: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.clearApiKey && value.apiKey), {
    message: "clearApiKey cannot be combined with apiKey",
    path: ["clearApiKey"],
  });

/**
 * XOR refinement used by both LLM and Exa branches of
 * {@link testConnectionBodySchema}: exactly one of `apiKey` / `useSavedKey`
 * must be present. Both-present or both-absent fail with a 400.
 */
function refineApiKeyXor<T extends { apiKey?: string | undefined; useSavedKey?: true | undefined }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  const hasDraft = value.apiKey !== undefined;
  const hasSaved = value.useSavedKey === true;
  if (hasDraft && hasSaved) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "apiKey and useSavedKey are mutually exclusive",
      path: ["apiKey"],
    });
  } else if (!hasDraft && !hasSaved) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of apiKey or useSavedKey must be provided",
      path: ["apiKey"],
    });
  }
}

const testConnectionLlmBodyBaseSchema = z
  .object({
    target: z.literal("llm"),
    provider: llmProviderTypeSchema,
    model: z.string().min(1),
    // Required when provider === "custom" (refined below). Must be HTTPS.
    endpointUrl: z.string().url().optional(),
    apiKey: z.preprocess(preserveBlankSecret, z.string().min(1).optional()),
    useSavedKey: z.literal(true).optional(),
  })
  .strict();

const testConnectionExaBodyBaseSchema = z
  .object({
    target: z.literal("exa"),
    apiKey: z.preprocess(preserveBlankSecret, z.string().min(1).optional()),
    useSavedKey: z.literal(true).optional(),
  })
  .strict();

/**
 * Body of `POST /api/settings/test-connection`.
 *
 * Discriminated union on `target`. For each branch:
 *   - `apiKey` and `useSavedKey` are XOR (refineApiKeyXor enforces 400 when
 *     both or neither are present).
 *   - For `target === "llm"`, `provider === "custom"` additionally requires
 *     `endpointUrl` to be present and HTTPS.
 */
export const testConnectionBodySchema = z.discriminatedUnion("target", [
  testConnectionLlmBodyBaseSchema.superRefine((value, ctx) => {
    refineApiKeyXor(value, ctx);
    if (value.provider === "custom") {
      if (!value.endpointUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "endpointUrl is required when provider === 'custom'",
          path: ["endpointUrl"],
        });
      } else if (!value.endpointUrl.startsWith("https://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "endpointUrl must be HTTPS",
          path: ["endpointUrl"],
        });
      }
    }
  }),
  testConnectionExaBodyBaseSchema.superRefine((value, ctx) => {
    refineApiKeyXor(value, ctx);
  }),
]) satisfies z.ZodType<TestConnectionBody>;

export const testConnectionResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      latencyMs: z.number().int().nonnegative(),
      providerEcho: z.object({ model: z.string().optional() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["auth", "model", "endpoint", "network", "rate_limit", "unknown"]),
      message: z.string().min(1),
    })
    .strict(),
]) satisfies z.ZodType<TestConnectionResponse>;

export const settingsUpdateSchema = z
  .object({
    signalProviders: z
      .object({
        parallel: hubspotEnrichmentUpdateSchema.optional(),
        exa: providerUpdateSchema.optional(),
        hubspotEnrichment: hubspotEnrichmentUpdateSchema.optional(),
        // Same shape/schema as exa — a real user-entered/rotatable key.
        trigify: providerUpdateSchema.optional(),
      })
      .strict()
      .optional(),
    llm: llmUpdateSchema.optional(),
    eligibility: z
      .object({
        propertyName: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    thresholds: thresholdConfigSchema.partial().optional(),
  })
  .strict() satisfies z.ZodType<SettingsUpdate>;
