import { hubspot, Text } from "@hubspot/ui-extensions";
import { createRenderer } from "@hubspot/ui-extensions/testing";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE_URL } from "../api-fetcher";
import { type UseSettingsArgs, useSettings } from "../use-settings";

const VALID_SETTINGS = {
  tenantId: "tenant-1",
  signalProviders: {
    exa: { enabled: true, hasApiKey: true },
    hubspotEnrichment: { enabled: true, hasApiKey: false },
    parallel: { enabled: false, hasApiKey: false },
    trigify: { enabled: false, hasApiKey: false },
  },
  llm: {
    provider: "openai" as const,
    model: "gpt-5.4-mini",
    hasApiKey: true,
  },
  eligibility: {
    propertyName: "hs_is_target_account",
  },
  thresholds: {
    freshnessMaxDays: 30,
    minConfidence: 0.5,
  },
};

function Probe({
  fetchSettings,
  updateSettings,
  triggerSave,
}: {
  fetchSettings?: UseSettingsArgs["fetchSettings"];
  updateSettings?: UseSettingsArgs["updateSettings"];
  triggerSave?: boolean;
}) {
  const state = useSettings({ fetchSettings, updateSettings });

  useEffect(() => {
    if (triggerSave && !state.loading && !state.saving && state.settings) {
      void state.save({
        signalProviders: {
          exa: { enabled: false },
        },
      });
    }
  }, [state, triggerSave]);

  return (
    <Text>
      {JSON.stringify({
        loading: state.loading,
        saving: state.saving,
        error: state.error ? state.error.message : null,
        tenantId: state.settings?.tenantId ?? null,
        exaEnabled: state.settings?.signalProviders.exa.enabled ?? null,
        exaHasApiKey: state.settings?.signalProviders.exa.hasApiKey ?? null,
        saveSucceeded: state.saveSucceeded,
        saveIsFn: typeof state.save === "function",
      })}
    </Text>
  );
}

function InlineFetcherProbe({ fetchSpy }: { fetchSpy: () => Promise<typeof VALID_SETTINGS> }) {
  const [tick, setTick] = useState(0);
  const state = useSettings({
    fetchSettings: () => fetchSpy(),
  });

  useEffect(() => {
    if (!state.loading && state.settings && tick === 0) {
      setTick(1);
    }
  }, [state.loading, state.settings, tick]);

  return (
    <Text>
      {JSON.stringify({
        loading: state.loading,
        tenantId: state.settings?.tenantId,
      })}
    </Text>
  );
}

describe("useSettings", () => {
  it("loads valid settings and exposes a save function", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<Probe fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
      expect(parsed.loading).toBe(false);
    });

    const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
    expect(parsed.error).toBeNull();
    expect(parsed.tenantId).toBe("tenant-1");
    expect(parsed.exaEnabled).toBe(true);
    expect(parsed.exaHasApiKey).toBe(true);
    expect(parsed.saveSucceeded).toBe(false);
    expect(parsed.saveIsFn).toBe(true);
  });

  it("updates the local settings state after a successful save", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn(async () => ({
      ...VALID_SETTINGS,
      signalProviders: {
        ...VALID_SETTINGS.signalProviders,
        exa: { enabled: false, hasApiKey: true },
      },
    }));

    renderer.render(
      <Probe fetchSettings={fetchSettings} updateSettings={updateSettings} triggerSave={true} />,
    );

    await renderer.waitFor(() => {
      const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
      expect(parsed.loading).toBe(false);
      expect(parsed.saving).toBe(false);
      expect(parsed.exaEnabled).toBe(false);
      expect(parsed.saveSucceeded).toBe(true);
    });

    expect(updateSettings).toHaveBeenCalledWith({
      signalProviders: {
        exa: { enabled: false },
      },
    });
  });

  it("surfaces validation errors for malformed settings responses", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => ({
      tenantId: "tenant-1",
    }));

    renderer.render(<Probe fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
      expect(parsed.loading).toBe(false);
    });

    const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
    expect(parsed.tenantId).toBeNull();
    expect(parsed.error).not.toBeNull();
  });

  it("uses the real hubspot.fetch transport when no custom fetchers are injected", async () => {
    const fetchSpy = vi.spyOn(hubspot, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => VALID_SETTINGS,
    } as unknown as Response);

    const renderer = createRenderer("settings");
    renderer.render(<Probe />);

    await renderer.waitFor(() => {
      const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
      expect(parsed.loading).toBe(false);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("hubspot.fetch was not called");
    const [url, options] = call;
    expect(url).toBe(`${DEFAULT_API_BASE_URL}/api/settings`);
    expect((options as { method: string }).method).toBe("GET");

    fetchSpy.mockRestore();
  });

  it("testConnection wraps the injected tester and returns its response on success", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const testConnection = vi.fn(async () => ({
      ok: true as const,
      latencyMs: 99,
    }));

    function TesterProbe() {
      const state = useSettings({ fetchSettings, testConnection });
      const [result, setResult] = useState<string>("");

      useEffect(() => {
        if (state.loading) return;
        if (result !== "") return;
        void state
          .testConnection({ target: "exa", useSavedKey: true })
          .then((r) => setResult(JSON.stringify(r)));
      }, [state.loading, state.testConnection, result]);

      return <Text>{result || "pending"}</Text>;
    }

    renderer.render(<TesterProbe />);

    await renderer.waitFor(() => {
      const parsed = renderer.find(Text).text ?? "";
      expect(parsed).not.toBe("pending");
    });

    expect(testConnection).toHaveBeenCalledTimes(1);
    const rendered = renderer.find(Text).text ?? "";
    expect(JSON.parse(rendered)).toEqual({ ok: true, latencyMs: 99 });
  });

  it("hook-level testConnection maps a thrown error to a network failure shape", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const testConnection = vi.fn(async () => {
      throw new Error("boom");
    });

    function TesterProbe() {
      const state = useSettings({ fetchSettings, testConnection });
      const [result, setResult] = useState<string>("");

      useEffect(() => {
        if (state.loading) return;
        if (result !== "") return;
        void state
          .testConnection({ target: "exa", useSavedKey: true })
          .then((r) => setResult(JSON.stringify(r)));
      }, [state.loading, state.testConnection, result]);

      return <Text>{result || "pending"}</Text>;
    }

    renderer.render(<TesterProbe />);

    await renderer.waitFor(() => {
      const parsed = renderer.find(Text).text ?? "";
      expect(parsed).not.toBe("pending");
    });

    const rendered = renderer.find(Text).text ?? "";
    const parsed = JSON.parse(rendered);
    expect(parsed).toMatchObject({ ok: false, code: "network" });
  });

  it("createSettingsConnectionTester maps HTTP 429 to { ok: false, code: 'rate_limit' }", async () => {
    const { createSettingsConnectionTester } = await import("../api-fetcher");
    const fetchSpy = vi.spyOn(hubspot, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    } as unknown as Response);

    const tester = createSettingsConnectionTester();
    const result = await tester({ target: "exa", useSavedKey: true });

    expect(result).toMatchObject({ ok: false, code: "rate_limit" });

    fetchSpy.mockRestore();
  });

  it("createSettingsConnectionTester maps HTTP 400/401 to { ok: false, code: 'unknown' }", async () => {
    const { createSettingsConnectionTester } = await import("../api-fetcher");
    const fetchSpy400 = vi.spyOn(hubspot, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({}),
    } as unknown as Response);

    const tester = createSettingsConnectionTester();
    const r1 = await tester({ target: "exa", useSavedKey: true });
    expect(r1).toMatchObject({ ok: false, code: "unknown" });

    fetchSpy400.mockRestore();

    const fetchSpy401 = vi.spyOn(hubspot, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({}),
    } as unknown as Response);

    const r2 = await tester({ target: "exa", useSavedKey: true });
    expect(r2).toMatchObject({ ok: false, code: "unknown" });

    fetchSpy401.mockRestore();
  });

  it("does not refetch forever when callers pass inline fetcher functions", async () => {
    const renderer = createRenderer("settings");
    const fetchSpy = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<InlineFetcherProbe fetchSpy={fetchSpy} />);

    await renderer.waitFor(() => {
      const parsed = JSON.parse(renderer.find(Text).text ?? "{}");
      expect(parsed.loading).toBe(false);
      expect(parsed.tenantId).toBe("tenant-1");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
