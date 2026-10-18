import type {
  LlmProviderType,
  SettingsResponse,
  SettingsUpdate,
  ThresholdConfig,
} from "@hap/config";
import { hasSavedSearchConfiguration } from "@hap/config";
import { type Database, llmConfig, providerConfig, tenants } from "@hap/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { DEFAULT_ELIGIBILITY_PROPERTY } from "../services/eligibility.js";
import { DEFAULT_THRESHOLDS, invalidateTenantConfig } from "./config-resolver.js";
import { encryptProviderKey } from "./encryption.js";

/**
 * Thrown when `updateSettings` receives a payload that passed initial
 * validation but violates a service-level invariant (defense-in-depth). The
 * route layer maps this to HTTP 400.
 */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

const MANAGED_SIGNAL_PROVIDERS = [
  { key: "exa", providerName: "exa" },
  { key: "hubspotEnrichment", providerName: "hubspot-enrichment" },
  { key: "trigify", providerName: "trigify" },
  { key: "parallel", providerName: "parallel" },
] as const;

const HUBSPOT_PROVIDER_NAME = "hubspot";
const ELIGIBILITY_PROPERTY_SETTINGS_KEY = "eligibilityPropertyName";

type SettingsServiceDeps = {
  db: Database;
  tenantId: string;
};

type ProviderRow = {
  providerName: string;
  enabled: boolean;
  apiKeyEncrypted: string | null;
  thresholds: unknown;
  settings: unknown;
};

type LlmRow = {
  providerName: string;
  modelName: string;
  apiKeyEncrypted: string | null;
  endpointUrl: string | null;
};

function parseThresholds(raw: unknown): Partial<ThresholdConfig> {
  const out: Partial<ThresholdConfig> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.freshnessMaxDays === "number" && Number.isFinite(rec.freshnessMaxDays)) {
      out.freshnessMaxDays = rec.freshnessMaxDays;
    }
    if (typeof rec.minConfidence === "number" && Number.isFinite(rec.minConfidence)) {
      out.minConfidence = rec.minConfidence;
    }
  }
  return out;
}

async function getTenantSettings(
  db: Database,
  tenantId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const value = rows[0]?.settings;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveEligibilityProperty(settings: unknown): string {
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    const raw = (settings as Record<string, unknown>)[ELIGIBILITY_PROPERTY_SETTINGS_KEY];
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
  }
  return DEFAULT_ELIGIBILITY_PROPERTY;
}

async function readSignalProviderRows(db: Database, tenantId: string): Promise<ProviderRow[]> {
  return db
    .select({
      providerName: providerConfig.providerName,
      enabled: providerConfig.enabled,
      apiKeyEncrypted: providerConfig.apiKeyEncrypted,
      thresholds: providerConfig.thresholds,
      settings: providerConfig.settings,
    })
    .from(providerConfig)
    .where(eq(providerConfig.tenantId, tenantId))
    .orderBy(asc(providerConfig.id));
}

async function readLlmRow(
  db: Database,
  tenantId: string,
  defaultProvider: LlmProviderType | undefined,
): Promise<LlmRow | null> {
  const rows = await db
    .select({
      providerName: llmConfig.providerName,
      modelName: llmConfig.modelName,
      apiKeyEncrypted: llmConfig.apiKeyEncrypted,
      endpointUrl: llmConfig.endpointUrl,
    })
    .from(llmConfig)
    .where(eq(llmConfig.tenantId, tenantId))
    .orderBy(asc(llmConfig.id));

  if (!rows[0]) return null;
  if (!defaultProvider) return rows[0];
  return rows.find((row) => row.providerName === defaultProvider) ?? null;
}

export async function readSettings(deps: SettingsServiceDeps): Promise<SettingsResponse> {
  const { db, tenantId } = deps;
  const tenantSettings = await getTenantSettings(db, tenantId);
  const defaultProvider =
    typeof tenantSettings?.defaultLlmProvider === "string"
      ? (tenantSettings.defaultLlmProvider as LlmProviderType)
      : undefined;

  const providerRows = await readSignalProviderRows(db, tenantId);
  const rowByProvider = new Map(providerRows.map((row) => [row.providerName, row]));

  const thresholdSource = MANAGED_SIGNAL_PROVIDERS.map(({ providerName }) =>
    rowByProvider.get(providerName),
  ).find((row) => row);
  const thresholds: ThresholdConfig = {
    ...DEFAULT_THRESHOLDS,
    ...(thresholdSource ? parseThresholds(thresholdSource.thresholds) : {}),
  };

  const hubspotSettings = rowByProvider.get(HUBSPOT_PROVIDER_NAME)?.settings;
  const llmRow = await readLlmRow(db, tenantId, defaultProvider);

  return {
    tenantId,
    signalProviders: {
      parallel: {
        enabled:
          rowByProvider.get("parallel")?.enabled ??
          !hasSavedSearchConfiguration(rowByProvider.keys()),
        hasApiKey: false,
      },
      exa: {
        enabled: rowByProvider.get("exa")?.enabled ?? false,
        hasApiKey: !!rowByProvider.get("exa")?.apiKeyEncrypted,
      },
      hubspotEnrichment: {
        enabled: rowByProvider.get("hubspot-enrichment")?.enabled ?? false,
        hasApiKey: !!rowByProvider.get("hubspot-enrichment")?.apiKeyEncrypted,
      },
      trigify: {
        enabled: rowByProvider.get("trigify")?.enabled ?? false,
        hasApiKey: !!rowByProvider.get("trigify")?.apiKeyEncrypted,
      },
    },
    llm: {
      provider: (llmRow?.providerName as LlmProviderType | undefined) ?? null,
      model: llmRow?.modelName ?? "",
      endpointUrl: llmRow?.endpointUrl || undefined,
      hasApiKey: !!llmRow?.apiKeyEncrypted,
    },
    eligibility: {
      propertyName: resolveEligibilityProperty(hubspotSettings),
    },
    thresholds,
  };
}

async function upsertSignalProvider(
  db: Database,
  tenantId: string,
  providerName: string,
  set: {
    enabled?: boolean;
    apiKeyEncrypted?: string | null;
    thresholds?: ThresholdConfig;
    settings?: Record<string, unknown>;
  },
): Promise<void> {
  const values: {
    tenantId: string;
    providerName: string;
    enabled?: boolean;
    apiKeyEncrypted?: string | null;
    thresholds?: ThresholdConfig;
    settings?: Record<string, unknown>;
  } = {
    tenantId,
    providerName,
  };

  if (set.enabled !== undefined) values.enabled = set.enabled;
  if (set.apiKeyEncrypted !== undefined) values.apiKeyEncrypted = set.apiKeyEncrypted;
  if (set.thresholds !== undefined) values.thresholds = set.thresholds;
  if (set.settings !== undefined) values.settings = set.settings;

  const updateSet: Record<string, unknown> = {};
  if (set.enabled !== undefined) updateSet.enabled = set.enabled;
  if (set.apiKeyEncrypted !== undefined) updateSet.apiKeyEncrypted = set.apiKeyEncrypted;
  if (set.thresholds !== undefined) updateSet.thresholds = set.thresholds;
  if (set.settings !== undefined) updateSet.settings = set.settings;

  await db
    .insert(providerConfig)
    .values({
      tenantId: values.tenantId,
      providerName: values.providerName,
      enabled: values.enabled ?? false,
      apiKeyEncrypted: values.apiKeyEncrypted ?? null,
      thresholds: values.thresholds ?? {},
      settings: values.settings ?? {},
    })
    .onConflictDoUpdate({
      target: [providerConfig.tenantId, providerConfig.providerName],
      set: updateSet,
    });
}

async function upsertLlmProvider(
  db: Database,
  tenantId: string,
  provider: LlmProviderType,
  set: {
    model: string;
    apiKeyEncrypted?: string | null;
    endpointUrl?: string | null;
  },
): Promise<void> {
  const updateSet: Record<string, unknown> = {
    modelName: set.model,
  };
  if (set.apiKeyEncrypted !== undefined) updateSet.apiKeyEncrypted = set.apiKeyEncrypted;
  if (set.endpointUrl !== undefined) updateSet.endpointUrl = set.endpointUrl;

  await db
    .insert(llmConfig)
    .values({
      tenantId,
      providerName: provider,
      modelName: set.model,
      apiKeyEncrypted: set.apiKeyEncrypted ?? null,
      endpointUrl: set.endpointUrl ?? null,
    })
    .onConflictDoUpdate({
      target: [llmConfig.tenantId, llmConfig.providerName],
      set: updateSet,
    });
}

export async function updateSettings(
  deps: SettingsServiceDeps,
  update: SettingsUpdate,
): Promise<void> {
  const { db, tenantId } = deps;

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;

    const existingProviders = await readSignalProviderRows(txDb, tenantId);
    const providerByName = new Map(existingProviders.map((row) => [row.providerName, row]));
    const tenantSettings = (await getTenantSettings(txDb, tenantId)) ?? {};
    const currentDefaultProvider =
      typeof tenantSettings.defaultLlmProvider === "string"
        ? (tenantSettings.defaultLlmProvider as LlmProviderType)
        : undefined;

    if (update.thresholds) {
      const existingThresholdSource = MANAGED_SIGNAL_PROVIDERS.map(({ providerName }) =>
        providerByName.get(providerName),
      ).find((row) => row);

      const nextThresholds: ThresholdConfig = {
        ...DEFAULT_THRESHOLDS,
        ...(existingThresholdSource ? parseThresholds(existingThresholdSource.thresholds) : {}),
        ...update.thresholds,
      };

      const searchPatch = update.signalProviders;
      const persistDefault =
        !hasSavedSearchConfiguration(providerByName.keys()) &&
        !searchPatch?.exa &&
        !searchPatch?.trigify &&
        !searchPatch?.parallel;
      for (const { providerName } of MANAGED_SIGNAL_PROVIDERS) {
        const existing = providerByName.get(providerName);
        if (!existing && !(persistDefault && providerName === "parallel")) continue;
        await upsertSignalProvider(txDb, tenantId, providerName, {
          enabled: existing?.enabled ?? providerName === "parallel",
          apiKeyEncrypted: existing?.apiKeyEncrypted ?? null,
          thresholds: nextThresholds,
        });
      }
    }

    if (update.signalProviders) {
      const parallelPatch = update.signalProviders.parallel;
      if (parallelPatch) {
        if (Object.keys(parallelPatch).some((key) => key !== "enabled")) {
          throw new SettingsValidationError("parallel accepts only enabled");
        }
        const existing = providerByName.get("parallel");
        await upsertSignalProvider(txDb, tenantId, "parallel", {
          enabled:
            parallelPatch.enabled ??
            existing?.enabled ??
            !hasSavedSearchConfiguration(providerByName.keys()),
          thresholds: {
            ...DEFAULT_THRESHOLDS,
            ...parseThresholds(existing?.thresholds),
            ...update.thresholds,
          },
        });
      }
      const exaPatch = update.signalProviders.exa;
      if (exaPatch) {
        const existing = providerByName.get("exa");
        await upsertSignalProvider(txDb, tenantId, "exa", {
          enabled: exaPatch.enabled ?? existing?.enabled ?? false,
          apiKeyEncrypted: exaPatch.clearApiKey
            ? null
            : exaPatch.apiKey
              ? encryptProviderKey(tenantId, exaPatch.apiKey)
              : (existing?.apiKeyEncrypted ?? null),
          thresholds: {
            ...DEFAULT_THRESHOLDS,
            ...parseThresholds(existing?.thresholds),
            ...update.thresholds,
          },
        });
      }

      const trigifyPatch = update.signalProviders.trigify;
      if (trigifyPatch) {
        // Same shape/handling as exa — a real user-entered/rotatable key.
        // `apiKey` omitted preserves the existing ciphertext; `clearApiKey`
        // deletes it; the Zod schema (settings.ts) already rejects
        // apiKey+clearApiKey combined before this code runs.
        const existing = providerByName.get("trigify");
        await upsertSignalProvider(txDb, tenantId, "trigify", {
          enabled: trigifyPatch.enabled ?? existing?.enabled ?? false,
          apiKeyEncrypted: trigifyPatch.clearApiKey
            ? null
            : trigifyPatch.apiKey
              ? encryptProviderKey(tenantId, trigifyPatch.apiKey)
              : (existing?.apiKeyEncrypted ?? null),
          thresholds: {
            ...DEFAULT_THRESHOLDS,
            ...parseThresholds(existing?.thresholds),
            ...update.thresholds,
          },
        });
      }

      const enrichmentPatch = update.signalProviders.hubspotEnrichment;
      if (enrichmentPatch) {
        // Defense in depth: the validator already rejects `apiKey` /
        // `clearApiKey` for the OAuth-backed HubSpot enrichment slot. If a
        // caller somehow bypasses the validator, surface a hard error rather
        // than silently dropping the field.
        const stray = enrichmentPatch as {
          apiKey?: unknown;
          clearApiKey?: unknown;
        };
        if (stray.apiKey !== undefined || stray.clearApiKey !== undefined) {
          throw new SettingsValidationError(
            "hubspotEnrichment does not accept apiKey/clearApiKey; it is OAuth-backed",
          );
        }
        const existing = providerByName.get("hubspot-enrichment");
        await upsertSignalProvider(txDb, tenantId, "hubspot-enrichment", {
          enabled: enrichmentPatch.enabled ?? existing?.enabled ?? false,
          // Preserve any historical ciphertext rather than deleting — the DB
          // migration path owns cleanup. No API key is ever written here.
          apiKeyEncrypted: existing?.apiKeyEncrypted ?? null,
          thresholds: {
            ...DEFAULT_THRESHOLDS,
            ...parseThresholds(existing?.thresholds),
            ...update.thresholds,
          },
        });
      }
    }

    if (update.eligibility?.propertyName) {
      const existing = providerByName.get(HUBSPOT_PROVIDER_NAME);
      const existingSettings =
        existing?.settings &&
        typeof existing.settings === "object" &&
        !Array.isArray(existing.settings)
          ? (existing.settings as Record<string, unknown>)
          : {};

      await upsertSignalProvider(txDb, tenantId, HUBSPOT_PROVIDER_NAME, {
        // HubSpot base config is OAuth-backed and used only for settings lookup,
        // not end-user enable/disable gating like hubspot-enrichment.
        enabled: existing?.enabled ?? true,
        apiKeyEncrypted: existing?.apiKeyEncrypted ?? null,
        thresholds: {
          ...DEFAULT_THRESHOLDS,
          ...parseThresholds(existing?.thresholds),
        },
        settings: {
          ...existingSettings,
          [ELIGIBILITY_PROPERTY_SETTINGS_KEY]: update.eligibility.propertyName,
        },
      });
    }

    if (update.llm?.provider === null) {
      await tx.delete(llmConfig).where(eq(llmConfig.tenantId, tenantId));

      const { defaultLlmProvider: _removed, ...nextTenantSettings } = tenantSettings;
      await tx
        .update(tenants)
        .set({
          settings: nextTenantSettings,
          updatedAt: sql`now()`,
        })
        .where(eq(tenants.id, tenantId));
    } else if (update.llm?.provider && update.llm.model) {
      const existingRows = await tx
        .select({
          providerName: llmConfig.providerName,
          modelName: llmConfig.modelName,
          apiKeyEncrypted: llmConfig.apiKeyEncrypted,
          endpointUrl: llmConfig.endpointUrl,
        })
        .from(llmConfig)
        .where(
          and(eq(llmConfig.tenantId, tenantId), eq(llmConfig.providerName, update.llm.provider)),
        )
        .limit(1);

      const existing = existingRows[0];
      await upsertLlmProvider(txDb, tenantId, update.llm.provider, {
        model: update.llm.model,
        apiKeyEncrypted: update.llm.clearApiKey
          ? null
          : update.llm.apiKey
            ? encryptProviderKey(tenantId, update.llm.apiKey)
            : (existing?.apiKeyEncrypted ?? null),
        endpointUrl:
          update.llm.provider === "custom"
            ? (update.llm.endpointUrl ?? existing?.endpointUrl ?? null)
            : null,
      });

      await tx
        .delete(llmConfig)
        .where(
          and(
            eq(llmConfig.tenantId, tenantId),
            sql`${llmConfig.providerName} <> ${update.llm.provider}`,
          ),
        );

      await tx
        .update(tenants)
        .set({
          settings: {
            ...tenantSettings,
            defaultLlmProvider: update.llm.provider,
          },
          updatedAt: sql`now()`,
        })
        .where(eq(tenants.id, tenantId));
    } else if (currentDefaultProvider && (update.llm?.apiKey || update.llm?.clearApiKey)) {
      const existingRows = await tx
        .select({
          providerName: llmConfig.providerName,
          modelName: llmConfig.modelName,
          apiKeyEncrypted: llmConfig.apiKeyEncrypted,
          endpointUrl: llmConfig.endpointUrl,
        })
        .from(llmConfig)
        .where(
          and(eq(llmConfig.tenantId, tenantId), eq(llmConfig.providerName, currentDefaultProvider)),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        await upsertLlmProvider(txDb, tenantId, currentDefaultProvider, {
          model: existing.modelName,
          apiKeyEncrypted: update.llm.clearApiKey
            ? null
            : update.llm.apiKey
              ? encryptProviderKey(tenantId, update.llm.apiKey)
              : existing.apiKeyEncrypted,
          endpointUrl: existing.endpointUrl,
        });
      }
    }
  });

  invalidateTenantConfig(tenantId);
}
