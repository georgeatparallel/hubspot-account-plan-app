import type { Database } from "@hap/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalAdapter } from "../factory.js";
import { ParallelAdapter } from "../parallel.js";

const tenantId = "tenant-parallel";
const companyId = "901234567";
const sourceUrl = "https://example.com/news/expansion";
const article = {
  url: sourceUrl,
  title: "Acme expands",
  publish_date: "2026-10-01",
  excerpts: ["Acme opened a new office."],
};

type RequestRecord = {
  url: string;
  headers: Headers;
  body?: Record<string, unknown>;
  signal?: AbortSignal | null;
};
function fixture(
  options: {
    search?: unknown;
    fetchResult?: unknown;
    toolError?: boolean;
    status?: number;
    networkError?: boolean;
    hang?: boolean;
    malformed?: boolean;
    missingTools?: boolean;
    oversized?: boolean;
    onCall?: () => void;
    hangOnCall?: boolean;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? JSON.parse(await request.text()) : undefined;
    requests.push({ url: request.url, headers: request.headers, body, signal: request.signal });
    if (options.networkError) throw new Error("secret-provider-detail");
    if (options.hang || (options.hangOnCall && body?.method === "tools/call")) {
      options.onCall?.();
      return new Promise((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    }
    if (options.status) return new Response("private error", { status: options.status });
    if (!body || body.id === undefined) return new Response(null, { status: body ? 202 : 405 });
    let result: unknown;
    if (body.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "parallel-fixture", version: "1" },
      };
    if (body.method === "tools/list")
      result = {
        tools: (options.missingTools ? ["web_search"] : ["web_search", "web_fetch"]).map(
          (name) => ({ name, inputSchema: { type: "object", properties: {} } }),
        ),
      };
    if (body.method === "tools/call") {
      const params = body.params as { name: string };
      const payload =
        params.name === "web_search"
          ? (options.search ?? { results: [article] })
          : (options.fetchResult ?? {
              results: [{ ...article, excerpts: ["Fetched office expansion evidence."] }],
            });
      result = options.malformed
        ? { content: [{ type: "text", text: "not json" }] }
        : {
            isError: options.toolError ?? false,
            content: [{ type: "text", text: JSON.stringify(payload) }],
          };
    }
    if (options.oversized && body.method === "tools/call")
      return new Response("x".repeat(300_000), { headers: { "content-type": "application/json" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  return { requests, fetchImpl };
}
function adapter(
  fetchImpl: typeof fetch,
  props = { name: "Acme", domain: "acme.example" },
  timeoutMs?: number,
) {
  const getCompanyProperties = vi.fn().mockResolvedValue(props);
  return {
    adapter: new ParallelAdapter({
      tenantId,
      client: { getCompanyProperties },
      fetch: fetchImpl,
      config: timeoutMs ? { timeoutMs } : undefined,
    }),
    getCompanyProperties,
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("Parallel Search MCP adapter", () => {
  it("uses the official MCP handshake and tools with public company identity, a stable session and honest User-Agent, ignoring ambient keys", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "ambient-secret");
    const http = fixture();
    const { adapter: subject, getCompanyProperties } = adapter(http.fetchImpl);
    const evidence = await subject.fetchSignals(tenantId, { companyId });
    expect(getCompanyProperties).toHaveBeenCalledWith(companyId, ["name", "domain"]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      tenantId,
      source: "example.com",
      evidenceUrl: sourceUrl,
      confidence: 0.7,
      content: expect.stringContaining("Fetched office"),
    });
    expect(evidence[0].id).toBe(`parallel:${sourceUrl}`);
    expect(evidence[0].timestamp).toEqual(new Date("2026-10-01"));
    const calls = http.requests
      .filter((r) => r.body?.method === "tools/call")
      .map((r) => r.body?.params as { name: string; arguments: Record<string, unknown> });
    expect(calls.map((c) => c.name)).toEqual(["web_search", "web_fetch"]);
    expect(calls[0]?.arguments).toMatchObject({
      objective: expect.stringContaining("Acme"),
      search_queries: [expect.stringContaining("acme.example")],
      session_id: expect.any(String),
    });
    expect(calls[1]?.arguments).toMatchObject({
      urls: [sourceUrl],
      session_id: calls[0]?.arguments.session_id,
    });
    expect(JSON.stringify(calls)).not.toContain(companyId);
    for (const request of http.requests) {
      expect(request.url).toBe("https://search.parallel.ai/mcp");
      expect(request.headers.get("user-agent")).toContain("hubspot-account-plan-app");
      expect(request.headers.has("authorization")).toBe(false);
      expect(JSON.stringify(request)).not.toContain("ambient-secret");
    }
  });
  it("registers through the normal factory with tenant-bound HubSpot deps", async () => {
    const http = fixture();
    const subject = createSignalAdapter(
      {
        name: "parallel",
        enabled: true,
        apiKeyRef: "",
        thresholds: { freshnessMaxDays: 30, minConfidence: 0.5 },
      },
      {
        tenantId,
        db: {} as Database,
        hubspotClient: {
          getCompanyProperties: vi.fn().mockResolvedValue({ name: "Acme" }),
        } as never,
        fetch: http.fetchImpl,
      },
    );
    expect(subject.name).toBe("parallel");
    expect(await subject.fetchSignals(tenantId, { companyId })).toHaveLength(1);
  });
  it("does not query a CRM id when public identity is unavailable", async () => {
    const http = fixture();
    expect(
      await adapter(http.fetchImpl, { name: "", domain: "" }).adapter.fetchSignals(tenantId, {
        companyId,
      }),
    ).toEqual([]);
    expect(http.requests).toHaveLength(0);
  });
  it("rejects tenant mismatch before any CRM or MCP access", async () => {
    const http = fixture();
    const subject = adapter(http.fetchImpl);
    await expect(subject.adapter.fetchSignals("other-tenant", { companyId })).rejects.toThrow();
    expect(subject.getCompanyProperties).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  });
  it("bounds content/results, excludes unsafe URLs and keeps unknown publication dates stale", async () => {
    const rows = [
      { ...article, url: "javascript:alert(1)" },
      { ...article, url: "https://user:pass@example.com/private" },
      ...Array.from({ length: 10 }, (_, n) => ({
        ...article,
        url: `${sourceUrl}/${n}`,
        publish_date: undefined,
        excerpts: ["x".repeat(6000)],
      })),
    ];
    const http = fixture({ search: { results: rows }, fetchResult: { results: [] } });
    const evidence = await adapter(http.fetchImpl).adapter.fetchSignals(tenantId, { companyId });
    expect(evidence).toHaveLength(5);
    for (const ev of evidence) {
      expect(ev.content.length).toBeLessThanOrEqual(2000);
      expect(ev.timestamp).toEqual(new Date(0));
      expect(ev.copyAssertable).toBe(false);
    }
  });
  it.each([
    { toolError: true },
    { malformed: true },
    { status: 429 },
    { status: 500 },
    { networkError: true },
  ])("fails safely for MCP/tool/HTTP/network errors: %j", async (opts) => {
    await expect(
      adapter(fixture(opts).fetchImpl).adapter.fetchSignals(tenantId, { companyId }),
    ).rejects.toThrow(/^parallel /);
  });
  it.each([
    { missingTools: true },
    { oversized: true },
    { fetchResult: { bad: "shape" } },
    { search: { results: "invalid" } },
  ])("rejects missing discovery tools, oversized wire bodies and malformed tool payloads: %j", async (opts) => {
    await expect(
      adapter(fixture(opts).fetchImpl).adapter.fetchSignals(tenantId, { companyId }),
    ).rejects.toThrow(/^parallel /);
  });
  it("cancels an in-flight MCP request through the actual fetch signal", async () => {
    const controller = new AbortController();
    const http = fixture({
      hangOnCall: true,
      onCall: () => queueMicrotask(() => controller.abort()),
    });
    await expect(
      adapter(http.fetchImpl).adapter.fetchSignals(
        tenantId,
        { companyId },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/^parallel /);
    expect(
      http.requests.some(
        (request) => request.body?.method === "tools/call" && request.signal?.aborted,
      ),
    ).toBe(true);
  });
  it("does not search after cancellation during a pending CRM identity read", async () => {
    const controller = new AbortController();
    const http = fixture();
    const subject = new ParallelAdapter({
      tenantId,
      fetch: http.fetchImpl,
      client: {
        getCompanyProperties: () =>
          new Promise(() => {
            queueMicrotask(() => controller.abort());
          }),
      },
    });
    await expect(
      subject.fetchSignals(tenantId, { companyId }, { signal: controller.signal }),
    ).rejects.toThrow(/^parallel /);
    expect(http.requests).toEqual([]);
  });
  it("rejects unsafe endpoint/config overrides", () => {
    for (const config of [
      { endpoint: "http://localhost" },
      { toString: "not-a-limit" },
      { timeoutMs: 30_001 },
      { maxResults: 100 },
      { maxContentChars: 0 },
    ]) {
      expect(
        () => new ParallelAdapter({ tenantId, client: { getCompanyProperties: vi.fn() }, config }),
      ).toThrow(/^parallel /);
    }
  });
  it("honors caller cancellation and a bounded transport timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const http = fixture();
    await expect(
      adapter(http.fetchImpl).adapter.fetchSignals(
        tenantId,
        { companyId },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
    await expect(
      adapter(
        fixture({ hang: true }).fetchImpl,
        { name: "Acme", domain: "acme.example" },
        25,
      ).adapter.fetchSignals(tenantId, { companyId }),
    ).rejects.toThrow(/^parallel /);
  });
});
