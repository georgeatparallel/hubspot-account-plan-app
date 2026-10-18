import { randomUUID } from "node:crypto";
import { createDatabase, llmConfig, providerConfig, tenants } from "@hap/db";
import { settingsResponseSchema } from "@hap/validators";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetEncryptionCacheForTests, decryptProviderKey } from "../encryption";
import { readSettings, SettingsValidationError, updateSettings } from "../settings-service";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://hap:hap_local_dev@localhost:5433/hap_dev";

const db = createDatabase(DATABASE_URL);
const PORTAL_PREFIX = `settingssvc-${randomUUID().slice(0, 8)}-`;
const ROOT_KEK_BASE64 = Buffer.alloc(32, 9).toString("base64");
let savedRootKek: string | undefined;

beforeAll(() => {
  savedRootKek = process.env.ROOT_KEK;
  process.env.ROOT_KEK = ROOT_KEK_BASE64;
  __resetEncryptionCacheForTests();
});

function portalId() {
  return `${PORTAL_PREFIX}${randomUUID().slice(0, 8)}`;
}

async function seedTenant(settings?: Record<string, unknown>) {
  const [row] = await db
    .insert(tenants)
    .values({
      hubspotPortalId: portalId(),
      name: "Settings Service Tenant",
      settings: settings ?? {},
    })
    .returning();
  if (!row) throw new Error("failed to seed tenant");
  return row;
}

beforeEach(async () => {
  await db.delete(tenants).where(like(tenants.hubspotPortalId, `${PORTAL_PREFIX}%`));
});

afterAll(async () => {
  await db.delete(tenants).where(like(tenants.hubspotPortalId, `${PORTAL_PREFIX}%`));
  if (savedRootKek !== undefined) {
    process.env.ROOT_KEK = savedRootKek;
  } else {
    delete process.env.ROOT_KEK;
  }
  __resetEncryptionCacheForTests();
});

describe("readSettings", () => {
  it("returns the default settings shape when no config rows exist", async () => {
    const tenant = await seedTenant();

    const settings = await readSettings({ db, tenantId: tenant.id });

    expect(settings).toEqual({
      tenantId: tenant.id,
      signalProviders: {
        exa: { enabled: false, hasApiKey: false },
        hubspotEnrichment: { enabled: false, hasApiKey: false },
        parallel: { enabled: true, hasApiKey: false },
        trigify: { enabled: false, hasApiKey: false },
      },
      llm: {
        provider: null,
        model: "",
        endpointUrl: undefined,
        hasApiKey: false,
      },
      eligibility: {
        propertyName: "hs_is_target_account",
      },
      thresholds: {
        freshnessMaxDays: 30,
        minConfidence: 0.5,
      },
    });
  });

  it("normalizes a blank endpoint_url so the response schema accepts it", async () => {
    const tenant = await seedTenant();

    await db.insert(llmConfig).values({
      tenantId: tenant.id,
      providerName: "openai",
      modelName: "gpt-5.4-mini",
      apiKeyEncrypted: null,
      endpointUrl: "",
    });

    const settings = await readSettings({ db, tenantId: tenant.id });

    expect(settings.llm.endpointUrl).toBeUndefined();
    expect(() => settingsResponseSchema.parse(settings)).not.toThrow();
  });
});

describe("updateSettings", () => {
  it("writes encrypted provider and llm keys and reflects them in the read model", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          exa: { enabled: true, apiKey: "exa-secret-1" },
          hubspotEnrichment: { enabled: true },
        },
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          apiKey: "openai-secret-1",
        },
        eligibility: {
          propertyName: "custom_target_property",
        },
        thresholds: {
          freshnessMaxDays: 14,
          minConfidence: 0.4,
        },
      },
    );

    const [exaRow] = await db
      .select()
      .from(providerConfig)
      .where(and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "exa")));
    expect(exaRow?.enabled).toBe(true);
    expect(exaRow?.apiKeyEncrypted).toBeTruthy();
    expect(decryptProviderKey(tenant.id, exaRow?.apiKeyEncrypted ?? "")).toBe("exa-secret-1");

    const [llmRow] = await db
      .select()
      .from(llmConfig)
      .where(and(eq(llmConfig.tenantId, tenant.id), eq(llmConfig.providerName, "openai")));
    expect(llmRow?.modelName).toBe("gpt-5.4-mini");
    expect(llmRow?.apiKeyEncrypted).toBeTruthy();
    expect(decryptProviderKey(tenant.id, llmRow?.apiKeyEncrypted ?? "")).toBe("openai-secret-1");

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.signalProviders.exa).toEqual({
      enabled: true,
      hasApiKey: true,
    });
    expect(settings.signalProviders.hubspotEnrichment).toEqual({
      enabled: true,
      hasApiKey: false,
    });
    expect((settings.signalProviders as Record<string, unknown>).news).toBeUndefined();
    expect(settings.llm).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      endpointUrl: undefined,
      hasApiKey: true,
    });
    expect(settings.eligibility.propertyName).toBe("custom_target_property");
    expect(settings.thresholds).toEqual({
      freshnessMaxDays: 14,
      minConfidence: 0.4,
    });
  });

  it("preserves existing encrypted secrets when the update omits apiKey", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          exa: { enabled: true, apiKey: "exa-secret-1" },
        },
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "anthropic-secret-1",
        },
      },
    );

    const [beforeExa] = await db
      .select()
      .from(providerConfig)
      .where(and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "exa")));
    const [beforeLlm] = await db
      .select()
      .from(llmConfig)
      .where(and(eq(llmConfig.tenantId, tenant.id), eq(llmConfig.providerName, "anthropic")));

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          exa: { enabled: false },
        },
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
    );

    const [afterExa] = await db
      .select()
      .from(providerConfig)
      .where(and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "exa")));
    const [afterLlm] = await db
      .select()
      .from(llmConfig)
      .where(and(eq(llmConfig.tenantId, tenant.id), eq(llmConfig.providerName, "anthropic")));

    expect(afterExa?.enabled).toBe(false);
    expect(afterExa?.apiKeyEncrypted).toBe(beforeExa?.apiKeyEncrypted);
    expect(afterLlm?.apiKeyEncrypted).toBe(beforeLlm?.apiKeyEncrypted);
    expect(decryptProviderKey(tenant.id, afterExa?.apiKeyEncrypted ?? "")).toBe("exa-secret-1");
    expect(decryptProviderKey(tenant.id, afterLlm?.apiKeyEncrypted ?? "")).toBe(
      "anthropic-secret-1",
    );
  });

  it("clears llm configuration when the settings payload disables the llm provider", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          apiKey: "openai-secret-1",
        },
      },
    );

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        llm: {
          provider: null,
        },
      },
    );

    const llmRows = await db.select().from(llmConfig).where(eq(llmConfig.tenantId, tenant.id));
    expect(llmRows).toHaveLength(0);

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.llm).toEqual({
      provider: null,
      model: "",
      endpointUrl: undefined,
      hasApiKey: false,
    });
  });

  it("clears the current llm api key without requiring a full provider/model rewrite", async () => {
    const tenant = await seedTenant({ defaultLlmProvider: "openai" });

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          apiKey: "openai-secret-1",
        },
      },
    );

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        llm: {
          clearApiKey: true,
        },
      },
    );

    const [llmRow] = await db
      .select()
      .from(llmConfig)
      .where(and(eq(llmConfig.tenantId, tenant.id), eq(llmConfig.providerName, "openai")));

    expect(llmRow?.apiKeyEncrypted).toBeNull();

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.llm).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      endpointUrl: undefined,
      hasApiKey: false,
    });
  });

  it("switching llm providers removes stale rows and only exposes the active provider", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "anthropic-secret-1",
        },
      },
    );

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          apiKey: "openai-secret-1",
        },
      },
    );

    const llmRows = await db
      .select({
        providerName: llmConfig.providerName,
      })
      .from(llmConfig)
      .where(eq(llmConfig.tenantId, tenant.id));

    expect(llmRows).toEqual([{ providerName: "openai" }]);

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.llm).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      endpointUrl: undefined,
      hasApiKey: true,
    });
  });

  it("writes an encrypted trigify key and reflects hasApiKey/enabled in the read model", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          trigify: { enabled: true, apiKey: "trigify-secret-1" },
        },
      },
    );

    const [trigifyRow] = await db
      .select()
      .from(providerConfig)
      .where(
        and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "trigify")),
      );
    expect(trigifyRow?.enabled).toBe(true);
    expect(trigifyRow?.apiKeyEncrypted).toBeTruthy();
    expect(decryptProviderKey(tenant.id, trigifyRow?.apiKeyEncrypted ?? "")).toBe(
      "trigify-secret-1",
    );

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.signalProviders.trigify).toEqual({
      enabled: true,
      hasApiKey: true,
    });
  });

  it("rotates a trigify key: preserves the old key when apiKey is omitted, replaces it when present", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          trigify: { enabled: true, apiKey: "trigify-key-v1" },
        },
      },
    );

    // Omitting apiKey on a subsequent update preserves the existing ciphertext.
    await updateSettings(
      { db, tenantId: tenant.id },
      { signalProviders: { trigify: { enabled: false } } },
    );
    const [afterDisable] = await db
      .select()
      .from(providerConfig)
      .where(
        and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "trigify")),
      );
    expect(afterDisable?.enabled).toBe(false);
    expect(decryptProviderKey(tenant.id, afterDisable?.apiKeyEncrypted ?? "")).toBe(
      "trigify-key-v1",
    );

    // Supplying a new apiKey rotates it.
    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          trigify: { enabled: true, apiKey: "trigify-key-v2" },
        },
      },
    );
    const [afterRotate] = await db
      .select()
      .from(providerConfig)
      .where(
        and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "trigify")),
      );
    expect(decryptProviderKey(tenant.id, afterRotate?.apiKeyEncrypted ?? "")).toBe(
      "trigify-key-v2",
    );
  });

  it("clears a stored trigify key via clearApiKey", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          trigify: { enabled: true, apiKey: "trigify-key-to-clear" },
        },
      },
    );
    await updateSettings(
      { db, tenantId: tenant.id },
      { signalProviders: { trigify: { clearApiKey: true } } },
    );

    const [row] = await db
      .select()
      .from(providerConfig)
      .where(
        and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "trigify")),
      );
    expect(row?.apiKeyEncrypted).toBeNull();

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.signalProviders.trigify.hasApiKey).toBe(false);
  });

  it("rejects an attempt to store an apiKey on hubspotEnrichment", async () => {
    const tenant = await seedTenant();

    await expect(
      updateSettings(
        { db, tenantId: tenant.id },
        {
          signalProviders: {
            hubspotEnrichment: { enabled: true, apiKey: "fake" } as unknown as {
              enabled?: boolean;
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(SettingsValidationError);

    // Guard must run before any write — no row should exist.
    const rows = await db
      .select()
      .from(providerConfig)
      .where(
        and(
          eq(providerConfig.tenantId, tenant.id),
          eq(providerConfig.providerName, "hubspot-enrichment"),
        ),
      );
    expect(rows[0]?.apiKeyEncrypted ?? null).toBeNull();
  });

  it("no longer writes or reads a 'news' provider slot", async () => {
    const tenant = await seedTenant();

    await updateSettings(
      { db, tenantId: tenant.id },
      {
        signalProviders: {
          exa: { enabled: true, apiKey: "exa-secret" },
        },
      },
    );

    const rows = await db
      .select()
      .from(providerConfig)
      .where(and(eq(providerConfig.tenantId, tenant.id), eq(providerConfig.providerName, "news")));
    expect(rows).toHaveLength(0);

    const settings = await readSettings({ db, tenantId: tenant.id });
    expect((settings.signalProviders as Record<string, unknown>).news).toBeUndefined();
  });
});

describe("Parallel defaults and settings preservation", () => {
  it("shows anonymous Parallel by default, and retains that default across threshold-only writes", async () => {
    const tenant = await seedTenant();
    expect((await readSettings({ db, tenantId: tenant.id })).signalProviders.parallel).toEqual({
      enabled: true,
      hasApiKey: false,
    });
    await updateSettings({ db, tenantId: tenant.id }, { thresholds: { freshnessMaxDays: 7 } });
    const settings = await readSettings({ db, tenantId: tenant.id });
    expect(settings.signalProviders.parallel.enabled).toBe(true);
    expect(settings.thresholds.freshnessMaxDays).toBe(7);
    const rows = await db
      .select()
      .from(providerConfig)
      .where(eq(providerConfig.tenantId, tenant.id));
    expect(rows.map((r) => r.providerName)).toEqual(["parallel"]);
    expect(rows[0]?.enabled).toBe(true);
  });
  it("can explicitly disable Parallel and preserves that choice during unrelated updates", async () => {
    const tenant = await seedTenant();
    await updateSettings(
      { db, tenantId: tenant.id },
      { signalProviders: { parallel: { enabled: false } } },
    );
    await updateSettings(
      { db, tenantId: tenant.id },
      { thresholds: { minConfidence: 0.6 }, eligibility: { propertyName: "hs_is_target_account" } },
    );
    expect((await readSettings({ db, tenantId: tenant.id })).signalProviders.parallel.enabled).toBe(
      false,
    );
  });
  it("does not show Parallel enabled when a legacy search provider has a saved disabled row", async () => {
    const tenant = await seedTenant();
    await db
      .insert(providerConfig)
      .values({ tenantId: tenant.id, providerName: "exa", enabled: false });
    expect((await readSettings({ db, tenantId: tenant.id })).signalProviders.parallel.enabled).toBe(
      false,
    );
  });
});
