import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "@hap/config";
import { createDatabase, llmConfig, providerConfig, tenantHubspotOauth, tenants } from "@hap/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigResolverCache } from "../../lib/config-resolver.js";
import { encryptProviderKey } from "../../lib/encryption.js";
import { clearEligibilityCache } from "../../services/eligibility.js";
import { assembleSnapshot } from "../../services/snapshot-assembler.js";
import { resolveSignalAdapter, snapshotRoutes } from "../snapshot.js";

const db = createDatabase(
  process.env.DATABASE_URL ?? "postgresql://hap:hap_local_dev@localhost:5433/hap_dev",
);
const tenantIds: string[] = [];
async function tenant() {
  const [row] = await db
    .insert(tenants)
    .values({ hubspotPortalId: `parallel-${randomUUID()}`, name: "Parallel fixture tenant" })
    .returning();
  if (!row) throw new Error("tenant insert failed");
  tenantIds.push(row.id);
  return row.id;
}
beforeEach(() => {
  clearConfigResolverCache();
  clearEligibilityCache();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const id of tenantIds) await db.delete(tenants).where(eq(tenants.id, id));
});
function mcp() {
  const calls: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? JSON.parse(await request.text()) : undefined;
    if (!body || body.id === undefined) return new Response(null, { status: body ? 202 : 405 });
    let result: unknown;
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    if (body.method === "tools/list")
      result = {
        tools: ["web_search", "web_fetch"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    if (body.method === "tools/call") {
      calls.push(body.params);
      result = {
        structuredContent: {
          results: [
            {
              url: "https://acme.example/news",
              title: "New facility",
              publish_date: new Date(Date.now() - 86_400_000).toISOString(),
              excerpts: ["Acme opened a new manufacturing facility."],
            },
          ],
        },
        content: [],
      };
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  return { calls, fetchImpl };
}
describe("Parallel normal snapshot caller", () => {
  it("resolves fresh no-key configuration through factory and consumes MCP evidence in the trust/reason pipeline", async () => {
    const tenantId = await tenant();
    const http = mcp();
    const identity = vi.fn().mockResolvedValue({ name: "Acme", domain: "acme.example" });
    const resolution = await resolveSignalAdapter(db, tenantId, undefined, {
      fetch: http.fetchImpl,
      hubspotClient: { getCompanyProperties: identity } as never,
    });
    expect(resolution?.adapter.name).toBe("parallel");
    if (!resolution) throw new Error("missing default");
    const snapshot = await assembleSnapshot(
      {
        db,
        providerAdapter: resolution.adapter,
        propertyFetcher: async () => true,
        contactFetcher: async () => [],
        thresholds: resolution.thresholds as ProviderConfig["thresholds"],
      },
      { tenantId, companyId: "987654321" },
    );
    expect(identity).toHaveBeenCalledWith("987654321", ["name", "domain"]);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.reasonToContact).toBeTruthy();
    expect(snapshot.stateFlags).toMatchObject({ empty: false, degraded: false, stale: false });
    expect(JSON.stringify(http.calls)).not.toContain("987654321");
  });
  it.each([
    "exa",
    "trigify",
    "parallel",
  ])("preserves saved disabled %s instead of silently activating default", async (providerName) => {
    const tenantId = await tenant();
    await db.insert(providerConfig).values({ tenantId, providerName, enabled: false });
    expect(await resolveSignalAdapter(db, tenantId, undefined)).toBeNull();
  });
  it("preserves explicit Exa selection and news choice without adding Parallel", async () => {
    const tenantId = await tenant();
    await db
      .insert(providerConfig)
      .values({ tenantId, providerName: "exa", enabled: true, settings: { newsEnabled: false } });
    const resolution = await resolveSignalAdapter(db, tenantId, undefined);
    expect(resolution?.adapter.name).toBe("exa");
  });
  it("does not infer absence after config read fails", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("read failed");
      },
    };
    expect(await resolveSignalAdapter(brokenDb as never, randomUUID(), undefined)).toBeNull();
  });
  it("keeps a known explicitly enabled Exa config when an optional provider read fails", async () => {
    let reads = 0;
    const fakeDb = {
      select: () => {
        reads++;
        if (reads === 2) throw new Error("optional config read failed");
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: async () =>
            reads === 1
              ? [
                  {
                    providerName: "exa",
                    enabled: true,
                    apiKeyEncrypted: null,
                    thresholds: {},
                    settings: { newsEnabled: false },
                  },
                ]
              : [],
        };
        return chain;
      },
    };
    expect(
      (await resolveSignalAdapter(fakeDb as never, randomUUID(), undefined))?.adapter.name,
    ).toBe("exa");
  });
  it("preserves saved enabled Parallel and eligibility suppresses all external calls", async () => {
    const tenantId = await tenant();
    await db.insert(providerConfig).values({ tenantId, providerName: "parallel", enabled: true });
    const http = mcp();
    const identity = vi.fn();
    const resolution = await resolveSignalAdapter(db, tenantId, undefined, {
      fetch: http.fetchImpl,
      hubspotClient: { getCompanyProperties: identity } as never,
    });
    if (!resolution) throw new Error("missing configured Parallel");
    const snapshot = await assembleSnapshot(
      {
        db,
        providerAdapter: resolution.adapter,
        propertyFetcher: async () => false,
        contactFetcher: async () => [],
        thresholds: resolution.thresholds as ProviderConfig["thresholds"],
      },
      { tenantId, companyId: "999" },
    );
    expect(snapshot.eligibilityState).toBe("ineligible");
    expect(identity).not.toHaveBeenCalled();
    expect(http.calls).toEqual([]);
  });
});

describe("actual POST snapshot route with Parallel", () => {
  it.each([
    false,
    true,
  ])("uses real HubSpot identity and propagates caller cancellation through route/assembler/guards/composition (cancel=%s)", async (cancel) => {
    const tenantId = await tenant();
    await db
      .insert(llmConfig)
      .values({ tenantId, providerName: "openai", modelName: "test-model" });
    await db.insert(tenantHubspotOauth).values({
      tenantId,
      accessTokenEncrypted: encryptProviderKey(tenantId, "private-hubspot-token"),
      refreshTokenEncrypted: encryptProviderKey(tenantId, "private-refresh-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["crm.objects.companies.read"],
    });
    const controller = new AbortController();
    const http = mcp();
    const crmCalls: string[] = [];
    let cancelledSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://api.hubapi.com/")) {
        crmCalls.push(request.url);
        if (request.url.includes("/associations/")) return Response.json({ results: [] });
        return Response.json({
          properties: { name: "Acme", domain: "acme.example", hs_is_target_account: "true" },
        });
      }
      if (request.url.startsWith("https://api.openai.com/"))
        return new Response(null, { status: 503 });
      expect(request.url).toBe("https://search.parallel.ai/mcp");
      expect(request.headers.get("user-agent")).toContain("hubspot-account-plan-app");
      expect(request.headers.has("authorization")).toBe(false);
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      expect(JSON.stringify(body)).not.toContain("private-hubspot-token");
      expect(JSON.stringify(body)).not.toContain("987654321");
      if (cancel && body?.method === "tools/call") {
        cancelledSignal = request.signal;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("cancelled fixture")), {
            once: true,
          });
          controller.abort();
        });
      }
      return http.fetchImpl(request);
    }) as typeof fetch);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tenantId" as never, tenantId as never);
      c.set("db" as never, db as never);
      await next();
    });
    app.route("/snapshot", snapshotRoutes);
    const response = await app.request("/snapshot/987654321", {
      method: "POST",
      signal: controller.signal,
    });
    expect(
      crmCalls.some((url) => url.includes("properties=name") && url.includes("properties=domain")),
    ).toBe(true);
    if (cancel) {
      expect(cancelledSignal?.aborted).toBe(true);
      expect(http.calls).toEqual([]);
    } else {
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot.evidence).toHaveLength(1);
      expect(snapshot.reasonToContact).toBeTruthy();
    }
  });
});
