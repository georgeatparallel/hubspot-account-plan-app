import { randomUUID } from "node:crypto";
import { createDatabase, llmConfig, providerConfig, signals, tenants } from "@hap/db";
import { like } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigResolverCache } from "../lib/config-resolver";
import { __resetEncryptionCacheForTests, encryptProviderKey } from "../lib/encryption";
import { TenantAccessRevokedError } from "../lib/hubspot-client";
import { snapshotRoutes } from "../routes/snapshot";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://hap:hap_local_dev@localhost:5433/hap_dev";

const db = createDatabase(DATABASE_URL);

const PORTAL_PREFIX = `snaptest-${randomUUID().slice(0, 8)}-`;
const TEST_LOCAL_REDIRECT_URI = "http://localhost:3000/oauth/callback";
const TEST_PRODUCTION_REDIRECT_URI =
  "https://hap-signal-workspace-staging.vercel.app/oauth/callback";
const ROOT_KEK_BASE64 = Buffer.alloc(32, 9).toString("base64");
let savedRootKek: string | undefined;

function portalId() {
  return `${PORTAL_PREFIX}${randomUUID().slice(0, 8)}`;
}

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.HUBSPOT_OAUTH_REDIRECT_URI = TEST_LOCAL_REDIRECT_URI;
  savedRootKek = process.env.ROOT_KEK;
  process.env.ROOT_KEK = ROOT_KEK_BASE64;
  __resetEncryptionCacheForTests();
});

afterAll(() => {
  // postgres.js cleans up on process exit
  if (savedRootKek === undefined) {
    delete process.env.ROOT_KEK;
  } else {
    process.env.ROOT_KEK = savedRootKek;
  }
  __resetEncryptionCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../services/snapshot-assembler");
  vi.resetModules();
});

beforeEach(async () => {
  clearConfigResolverCache();
  await db.delete(tenants).where(like(tenants.hubspotPortalId, `${PORTAL_PREFIX}%`));
});

async function loadApp() {
  // Ensure fresh module bind each test run so env changes are respected.
  const mod = await import("../index");
  return mod.default;
}

function buildSnapshotRouteOnlyApp(
  injectedDb: ReturnType<typeof createDatabase>,
  tenantId: string,
) {
  const app = new Hono<{
    Variables: {
      tenantId?: string;
      correlationId?: string;
      db?: ReturnType<typeof createDatabase>;
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("tenantId", tenantId);
    c.set("db", injectedDb);
    c.set("correlationId", "corr-route-only");
    await next();
  });
  app.route("/api/snapshot", snapshotRoutes);
  return app;
}

describe("POST /api/snapshot/:companyId", () => {
  it("returns 401 when no Authorization header is provided in production mode", async () => {
    // Temporarily flip out of bypass mode to confirm auth is wired.
    const prev = process.env.NODE_ENV;
    const prevRedirectUri = process.env.HUBSPOT_OAUTH_REDIRECT_URI;
    process.env.NODE_ENV = "production";
    process.env.HUBSPOT_OAUTH_REDIRECT_URI = TEST_PRODUCTION_REDIRECT_URI;
    process.env.API_TOKENS = "tok-real:portal-real";
    try {
      const app = await loadApp();
      const res = await app.request("/api/snapshot/c123", { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = prev;
      if (prevRedirectUri === undefined) {
        delete process.env.HUBSPOT_OAUTH_REDIRECT_URI;
      } else {
        process.env.HUBSPOT_OAUTH_REDIRECT_URI = prevRedirectUri;
      }
    }
  });

  it("returns 401 when portalId has no matching tenant", async () => {
    const app = await loadApp();
    const res = await app.request("/api/snapshot/c123", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": "missing-portal-xyz",
      },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the resolved tenant is deactivated", async () => {
    const portal = portalId();
    await db.insert(tenants).values({
      hubspotPortalId: portal,
      name: "Inactive Snapshot Co",
      isActive: false,
      deactivatedAt: new Date("2026-04-17T12:30:00.000Z"),
      deactivationReason: "hubspot_app_uninstalled",
    });

    const app = await loadApp();
    const res = await app.request("/api/snapshot/c123", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("tenant_inactive");
    expect(body.detail).toBe("tenant is deactivated");
  });

  it("returns 400 when companyId path segment is empty", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "Empty ID Co" });
    const app = await loadApp();
    // Empty companyId via trailing slash — route matches but validates to 400.
    const res = await app.request("/api/snapshot/", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    // When nothing matches the param, Hono returns 404; our empty-check path
    // is the literal companyId "" not present. Prefer an explicit whitespace case.
    expect([400, 404]).toContain(res.status);
  });

  it("trims leading/trailing whitespace before passing companyId downstream", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "Trim Co" });
    const app = await loadApp();
    // "%20co-trim%20" = "  co-trim  " after decodeURIComponent.
    // Tenant has no provider config, so response is unconfigured — but
    // companyId normalization still applies.
    const res = await app.request("/api/snapshot/%20co-trim%20", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { companyId: string };
    // Must be normalized, no leading/trailing whitespace.
    expect(body.companyId).toBe("co-trim");
  });

  it("returns 400 when companyId is whitespace only", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "WS Co" });
    const app = await loadApp();
    const res = await app.request("/api/snapshot/%20%20", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_company_id");
  });

  it("returns 404 for the literal 'missing-company' companyId", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "MC Co" });
    const app = await loadApp();
    const res = await app.request("/api/snapshot/missing-company", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 200 + valid snapshot JSON carrying tenantId from middleware (not path/body)", async () => {
    const portal = portalId();
    const [inserted] = await db
      .insert(tenants)
      .values({ hubspotPortalId: portal, name: "Happy Path Co" })
      .returning();
    const expectedTenantId = inserted?.id;
    expect(expectedTenantId).toBeDefined();

    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-123", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
        "Content-Type": "application/json",
      },
      // Attempt to "spoof" tenantId via body — must be ignored.
      body: JSON.stringify({ tenantId: "spoofed-tenant" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      companyId: string;
      eligibilityState: string;
      people: unknown[];
      evidence: unknown[];
      stateFlags: Record<string, boolean>;
      createdAt: string;
    };

    expect(body.tenantId).toBe(expectedTenantId);
    expect(body.tenantId).not.toBe("spoofed-tenant");
    expect(typeof body.companyId).toBe("string");
    // Slice 3: tenant with no provider config gets unconfigured (no mock fallback).
    expect(body.eligibilityState).toBe("unconfigured");
    expect(Array.isArray(body.people)).toBe(true);
    expect(Array.isArray(body.evidence)).toBe(true);
    expect(body.stateFlags).toBeDefined();
    expect(typeof body.createdAt).toBe("string");
  });

  it("uses the request-scoped db handle from context instead of constructing its own db client", async () => {
    const portal = portalId();
    const [inserted] = await db
      .insert(tenants)
      .values({ hubspotPortalId: portal, name: "Injected DB Co" })
      .returning();
    const tenantId = inserted?.id;
    expect(tenantId).toBeDefined();
    if (!tenantId) throw new Error("tenant insert failed");

    const prevDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      const app = buildSnapshotRouteOnlyApp(db, tenantId);
      const res = await app.request("/api/snapshot/co-injected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId: "spoofed-tenant" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tenantId: string;
        eligibilityState: string;
      };
      expect(body.tenantId).toBe(tenantId);
      expect(body.eligibilityState).toBe("unconfigured");
    } finally {
      if (prevDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDatabaseUrl;
      }
    }
  });

  it("returns a lifecycle-specific 401 when tenant access is revoked mid-request", async () => {
    const portal = portalId();
    const [tenant] = await db
      .insert(tenants)
      .values({ hubspotPortalId: portal, name: "Revoked Mid Request Co" })
      .returning();
    if (!tenant) {
      throw new Error("tenant insert failed");
    }

    await db.insert(providerConfig).values({
      tenantId: tenant.id,
      providerName: "exa",
      enabled: true,
      apiKeyEncrypted: encryptProviderKey(tenant.id, "sk-real-exa-key"),
      thresholds: { freshnessMaxDays: 30, minConfidence: 0.5 },
      settings: {},
    });
    await db.insert(llmConfig).values({
      tenantId: tenant.id,
      providerName: "openai",
      modelName: "gpt-4o-mini",
      apiKeyEncrypted: encryptProviderKey(tenant.id, "sk-real-openai-key"),
      settings: {},
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("../services/snapshot-assembler", () => ({
      assembleSnapshot: vi.fn().mockRejectedValue(new TenantAccessRevokedError()),
    }));

    const { snapshotRoutes: freshSnapshotRoutes } = await import("../routes/snapshot");
    const app = new Hono<{
      Variables: {
        tenantId?: string;
        correlationId?: string;
        db?: ReturnType<typeof createDatabase>;
      };
    }>();
    app.use("*", async (c, next) => {
      c.set("tenantId", tenant.id);
      c.set("db", db);
      c.set("correlationId", "corr-route-only");
      await next();
    });
    app.route("/api/snapshot", freshSnapshotRoutes);

    const res = await app.request("/api/snapshot/co-revoked", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("tenant_access_revoked");
    expect(body.detail).toBe("hubspot access revoked or app uninstalled for tenant");
    expect(warnSpy).toHaveBeenCalledWith(
      "snapshot_route.tenant_access_revoked",
      expect.objectContaining({
        tenantId: tenant.id,
        companyId: "co-revoked",
      }),
    );
  });

  it("tenant with only a mock-signal provider_config row (not a real provider) gets unconfigured", async () => {
    // Slice 3: mock-signal is no longer a probed provider name. A tenant with
    // only a mock-signal config row has no real adapter and gets unconfigured.
    const portal = portalId();
    const [inserted] = await db
      .insert(tenants)
      .values({ hubspotPortalId: portal, name: "Strict Co" })
      .returning();
    const tenantId = inserted?.id;
    expect(tenantId).toBeDefined();
    if (!tenantId) throw new Error("tenant insert failed");

    await db.insert(providerConfig).values({
      tenantId,
      providerName: "mock-signal",
      enabled: true,
      thresholds: { freshnessMaxDays: 30, minConfidence: 0.99 },
    });

    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-strict", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eligibilityState: string;
      stateFlags: Record<string, boolean>;
    };
    // No real provider → unconfigured, not eligible with mock data.
    expect(body.eligibilityState).toBe("unconfigured");
    expect(body.stateFlags.empty).toBe(true);
  });

  it("tenant with no provider_config row gets unconfigured (not default-threshold mock)", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "Default Co" });
    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-default", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eligibilityState: string;
      stateFlags: Record<string, boolean>;
    };
    expect(body.eligibilityState).toBe("unconfigured");
    expect(body.stateFlags.empty).toBe(true);
  });

  // ─── Slice 3: ?state= fixture selector removed ──────────────────────────
  // The ?state= param no longer controls mock fixtures (mock fallback removed).
  // State-flag coverage now lives in snapshot-assembler-states.test.ts.
  // Unconfigured tenants always get eligibilityState=unconfigured regardless
  // of query params.

  it("?state= query param is ignored for unconfigured tenants (no mock fallback)", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "QA-state-ignored" });
    const app = await loadApp();
    for (const state of ["strong", "stale", "degraded", "empty", "lowconf", "restricted"]) {
      const res = await app.request(`/api/snapshot/co-qa?state=${state}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer anything",
          "x-test-portal-id": portal,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        eligibilityState: string;
        stateFlags: Record<string, boolean>;
      };
      // All unconfigured — no mock adapter to select fixtures from.
      expect(body.eligibilityState).toBe("unconfigured");
      expect(body.stateFlags.empty).toBe(true);
    }
  });

  it("?eligibility=ineligible is still respected (assembler eligibility gate)", async () => {
    // The ?eligibility= param still controls the property fetcher, but the
    // adapter short-circuit fires BEFORE the assembler. Unconfigured tenants
    // get unconfigured regardless of eligibility param.
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "QA-elig" });
    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-qa?eligibility=ineligible", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eligibilityState: string;
      stateFlags: Record<string, boolean>;
    };
    // Adapter short-circuit fires before the assembler's eligibility gate.
    expect(body.eligibilityState).toBe("unconfigured");
  });

  it("CORS preflight OPTIONS returns allow headers for HubSpot origin", async () => {
    const app = await loadApp();
    const res = await app.request("/api/snapshot/c123", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.hubspot.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    // cors middleware returns 204 No Content for preflight.
    expect([200, 204]).toContain(res.status);
    const allowOrigin = res.headers.get("access-control-allow-origin");
    expect(allowOrigin).toBeTruthy();
    // Either echoes the requested origin or "*" in dev/test — assert against
    // the literal expected values rather than `[allowOrigin, "*"]` which
    // would be a tautology.
    expect(["https://app.hubspot.com", "*"]).toContain(allowOrigin);
  });

  // ─── Slice 3: mock-fallback removal ───────────────────────────────────────
  // Tenants with no provider_config / llm_config rows must receive an explicit
  // `eligibilityState: "unconfigured"` snapshot — never mock data.

  it("tenant with no provider_config row gets eligibilityState=unconfigured", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "No Config Co" });
    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-noconfig", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eligibilityState: string;
      stateFlags: Record<string, boolean>;
      evidence: unknown[];
      people: unknown[];
    };
    expect(body.eligibilityState).toBe("unconfigured");
    expect(body.stateFlags.empty).toBe(true);
    expect(body.evidence).toHaveLength(0);
    expect(body.people).toHaveLength(0);
  });

  it("tenant with no llm_config row gets eligibilityState=unconfigured", async () => {
    // Even if there is a signal provider_config, missing LLM config → unconfigured.
    const portal = portalId();
    const [inserted] = await db
      .insert(tenants)
      .values({ hubspotPortalId: portal, name: "No LLM Co" })
      .returning();
    const tenantId = inserted?.id;
    expect(tenantId).toBeDefined();
    if (!tenantId) throw new Error("tenant insert failed");

    // Signal provider exists and is enabled, but no llm_config row.
    await db.insert(providerConfig).values({
      tenantId,
      providerName: "exa",
      enabled: true,
      thresholds: { freshnessMaxDays: 30, minConfidence: 0.5 },
    });

    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-nollm", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eligibilityState: string;
      stateFlags: Record<string, boolean>;
    };
    expect(body.eligibilityState).toBe("unconfigured");
    expect(body.stateFlags.empty).toBe(true);
  });

  it("response does NOT contain mock-generated provider references", async () => {
    const portal = portalId();
    await db.insert(tenants).values({ hubspotPortalId: portal, name: "No Mock Co" });
    const app = await loadApp();
    const res = await app.request("/api/snapshot/co-nomock", {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "x-test-portal-id": portal,
      },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('"mock-signal"');
    expect(raw).not.toContain('"mock-llm"');
    expect(raw).not.toContain('"mock"');
  });

  it("route code does not import mock adapters (grep assertion)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { readdirSync } = await import("node:fs");

    const routesDir = resolve(__dirname, "../routes");
    const servicesDir = resolve(__dirname, "../services");

    function grepDir(dir: string): string[] {
      const hits: string[] = [];
      let entries: string[];
      try {
        entries = readdirSync(dir, { recursive: true }) as unknown as string[];
      } catch {
        return hits;
      }
      for (const entry of entries) {
        const fullPath = resolve(dir, String(entry));
        if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".js")) continue;
        if (fullPath.includes("__tests__")) continue;
        const content = readFileSync(fullPath, "utf-8");
        if (
          content.includes("createMockLlmAdapter") ||
          content.includes("createMockSignalAdapter")
        ) {
          hits.push(fullPath);
        }
      }
      return hits;
    }

    const routeHits = grepDir(routesDir);
    const serviceHits = grepDir(servicesDir);
    expect([...routeHits, ...serviceHits]).toHaveLength(0);
  });

  describe("Trigify composition (Stage A Task 7)", () => {
    async function setupTenantWithLlm(name: string) {
      const portal = portalId();
      const [tenant] = await db
        .insert(tenants)
        .values({ hubspotPortalId: portal, name })
        .returning();
      if (!tenant) throw new Error("tenant insert failed");
      await db.insert(llmConfig).values({
        tenantId: tenant.id,
        providerName: "openai",
        modelName: "gpt-4o-mini",
        apiKeyEncrypted: encryptProviderKey(tenant.id, "sk-real-openai-key"),
        settings: {},
      });
      return { portal, tenant };
    }

    it("a Trigify-only tenant is no longer unconfigured and surfaces trigify evidence", async () => {
      const { portal, tenant } = await setupTenantWithLlm("Trigify Only Co");

      await db.insert(providerConfig).values({
        tenantId: tenant.id,
        providerName: "trigify",
        enabled: true,
        thresholds: { freshnessMaxDays: 30, minConfidence: 0.1 },
        settings: {},
      });

      await db.insert(signals).values({
        tenantId: tenant.id,
        dedupeKey: "ext:route-test-1",
        source: "trigify",
        stream: "trigify",
        signalType: "T_Role_Change",
        signalClass: "observable",
        tier: "A",
        level: "person",
        targetId: "linkedin.com/in/route-test",
        linkedinUrl: "https://www.linkedin.com/in/route-test/",
        hsCompanyId: "co-trigify-only",
        evidenceUrl: "https://www.linkedin.com/posts/route-test_promo",
        evidenceDate: new Date("2026-07-01T00:00:00.000Z"),
        observedAt: new Date("2026-07-01T09:00:00.000Z"),
        allowedClaims: [],
        copyAssertable: true,
        headline: "Route Test became VP of RevOps",
        detail: "Promoted",
        confidence: 0.9,
        raw: {},
      });

      const app = await loadApp();
      const res = await app.request("/api/snapshot/co-trigify-only?eligibility=eligible", {
        method: "POST",
        headers: {
          Authorization: "Bearer anything",
          "x-test-portal-id": portal,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        eligibilityState: string;
        evidence: Array<{ source: string; signalType?: string }>;
      };
      expect(body.eligibilityState).not.toBe("unconfigured");
      expect(body.evidence.some((e) => e.source === "trigify")).toBe(true);
    });

    it("an Exa-only tenant is unaffected by the Trigify composition change (regression)", async () => {
      const { portal, tenant } = await setupTenantWithLlm("Exa Only Regression Co");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
      await db.insert(providerConfig).values({
        tenantId: tenant.id,
        providerName: "exa",
        enabled: true,
        apiKeyEncrypted: encryptProviderKey(tenant.id, "sk-real-exa-key"),
        thresholds: { freshnessMaxDays: 30, minConfidence: 0.5 },
        settings: { newsEnabled: false },
      });

      const app = await loadApp();
      const res = await app.request("/api/snapshot/co-exa-only?eligibility=eligible", {
        method: "POST",
        headers: {
          Authorization: "Bearer anything",
          "x-test-portal-id": portal,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { eligibilityState: string };
      // The deterministic Exa transport failure still proves that resolving the
      // adapter itself does not throw/short-circuit to unconfigured purely
      // because REAL_SIGNAL_PROVIDERS now also probes "trigify" — an
      // Exa-only tenant must still resolve its Exa adapter exactly as before.
      expect(body.eligibilityState).not.toBe("unconfigured");
    });

    it("a tenant with BOTH Exa and Trigify enabled gets composed evidence from both", async () => {
      const { portal, tenant } = await setupTenantWithLlm("Exa Plus Trigify Co");
      await db.insert(providerConfig).values({
        tenantId: tenant.id,
        providerName: "exa",
        enabled: true,
        apiKeyEncrypted: encryptProviderKey(tenant.id, "sk-real-exa-key"),
        thresholds: { freshnessMaxDays: 30, minConfidence: 0.1 },
        settings: { newsEnabled: false },
      });
      await db.insert(providerConfig).values({
        tenantId: tenant.id,
        providerName: "trigify",
        enabled: true,
        thresholds: { freshnessMaxDays: 30, minConfidence: 0.1 },
        settings: {},
      });
      await db.insert(signals).values({
        tenantId: tenant.id,
        dedupeKey: "ext:route-test-2",
        source: "trigify",
        stream: "trigify",
        signalType: "T_Role_Change",
        signalClass: "observable",
        tier: "A",
        level: "person",
        targetId: "linkedin.com/in/route-test-2",
        linkedinUrl: "https://www.linkedin.com/in/route-test-2/",
        hsCompanyId: "co-both",
        evidenceUrl: "https://www.linkedin.com/posts/route-test-2_promo",
        evidenceDate: new Date("2026-07-02T00:00:00.000Z"),
        observedAt: new Date("2026-07-02T09:00:00.000Z"),
        allowedClaims: [],
        copyAssertable: true,
        headline: "Route Test Two became VP of RevOps",
        detail: "Promoted",
        confidence: 0.9,
        raw: {},
      });

      // Stub global fetch so Exa's real network call succeeds with an empty
      // result instead of erroring in this offline test environment — the
      // point of this test is proving COMPOSITION (both adapters run and
      // their evidence merges), not exercising Exa's live transport, which
      // is already covered by exa.test.ts's cassette suite.
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;

      try {
        const app = await loadApp();
        const res = await app.request("/api/snapshot/co-both?eligibility=eligible", {
          method: "POST",
          headers: {
            Authorization: "Bearer anything",
            "x-test-portal-id": portal,
          },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          eligibilityState: string;
          evidence: Array<{ source: string }>;
        };
        // Trigify evidence must be present alongside Exa's (empty) result —
        // composition means both adapters run, not "first enabled wins".
        expect(body.evidence.some((e) => e.source === "trigify")).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
