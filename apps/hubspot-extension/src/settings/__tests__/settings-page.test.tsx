import {
  Button,
  Heading,
  Input,
  LoadingButton,
  NumberInput,
  Select,
  Text,
  Toggle,
} from "@hubspot/ui-extensions";
import { createRenderer } from "@hubspot/ui-extensions/testing";
import { describe, expect, it, vi } from "vitest";
import { HubSpotSettingsPage } from "../settings-page";

function triggerValue(node: unknown, value: unknown) {
  (
    node as {
      trigger: (eventPropName: "onChange", eventArg?: unknown) => void;
    }
  ).trigger("onChange", value);
}

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

function findOptional<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

describe("HubSpotSettingsPage", () => {
  it("renders the settings sections and stored-secret indicators after load", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.findAll(Heading).length).toBeGreaterThanOrEqual(4);
    });

    const headings = renderer.findAll(Heading).map((node) => node.text ?? "");
    expect(headings).toContain("Signal Providers");
    expect(headings).toContain("LLM Settings");
    expect(headings).toContain("Eligibility");
    expect(headings).toContain("Thresholds");

    const allText = renderer
      .findAll(Text)
      .map((node) => node.text ?? "")
      .join(" ");
    expect(allText).toContain("Stored key on file");
  });

  it("does NOT render a News toggle or News API key input", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    expect(findOptional(() => renderer.find(Toggle, { name: "newsEnabled" }))).toBeUndefined();
    expect(findOptional(() => renderer.find(Input, { name: "newsApiKey" }))).toBeUndefined();
  });

  it("does NOT render a HubSpot enrichment API key input and shows an OAuth explainer", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    expect(
      findOptional(() => renderer.find(Input, { name: "hubspotEnrichmentApiKey" })),
    ).toBeUndefined();

    const allText = renderer
      .findAll(Text)
      .map((node) => node.text ?? "")
      .join(" ");
    expect(allText).toMatch(/OAuth/i);
  });

  it("hides the Endpoint URL input unless provider is 'custom'", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    // openai is the loaded provider — endpoint URL MUST NOT render
    expect(findOptional(() => renderer.find(Input, { name: "llmEndpointUrl" }))).toBeUndefined();

    // Switch to custom — endpoint URL appears
    triggerValue(renderer.find(Select, { name: "llmProvider" }), "custom");
    await renderer.waitFor(() => {
      expect(renderer.find(Input, { name: "llmEndpointUrl" })).toBeTruthy();
    });

    // Switch back to anthropic — endpoint URL gone again
    triggerValue(renderer.find(Select, { name: "llmProvider" }), "anthropic");
    await renderer.waitFor(() => {
      expect(findOptional(() => renderer.find(Input, { name: "llmEndpointUrl" }))).toBeUndefined();
    });
  });

  it("switches the Model dropdown options when the Provider changes", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    // Loaded provider is openai — model select should expose gpt-5.4 values
    const openaiModelSelect = renderer.find(Select, { name: "llmModel" });
    const openaiValues = (openaiModelSelect.props.options as { value: string }[]).map(
      (o) => o.value,
    );
    expect(openaiValues).toContain("gpt-5.4");
    expect(openaiValues).toContain("gpt-5.4-mini");
    expect(openaiValues).toContain("__other__");
    expect(openaiValues).not.toContain("claude-opus-4-7");

    // Switch to anthropic — model select options change to claude models
    triggerValue(renderer.find(Select, { name: "llmProvider" }), "anthropic");
    await renderer.waitFor(() => {
      const sel = renderer.find(Select, { name: "llmModel" });
      const values = (sel.props.options as { value: string }[]).map((o) => o.value);
      expect(values).toContain("claude-opus-4-7");
      expect(values).not.toContain("gpt-5.4");
    });
  });

  it("reveals a free-text model input when the user picks 'Other (type manually)'", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    // Free-text model input should NOT exist yet
    expect(findOptional(() => renderer.find(Input, { name: "llmModelOther" }))).toBeUndefined();

    triggerValue(renderer.find(Select, { name: "llmModel" }), "__other__");

    await renderer.waitFor(() => {
      expect(renderer.find(Input, { name: "llmModelOther" })).toBeTruthy();
    });
  });

  it("posts { clearApiKey: true } when the user clicks Clear on the Exa key", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    renderer.findByTestId(Button, "clearExaApiKey").trigger("onClick");
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    const call = (
      updateSettings.mock.calls as unknown as [
        {
          signalProviders?: {
            exa?: { clearApiKey?: boolean; apiKey?: string };
          };
        },
      ][]
    )[0];
    if (!call) throw new Error("updateSettings not called");
    const payload = call[0];
    expect(payload.signalProviders?.exa?.clearApiKey).toBe(true);
    expect(payload.signalProviders?.exa?.apiKey).toBeUndefined();
  });

  it("posts { clearApiKey: true } when the user clicks Clear on the LLM key", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    renderer.findByTestId(Button, "clearLlmApiKey").trigger("onClick");
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    const call = (
      updateSettings.mock.calls as unknown as [
        { llm?: { clearApiKey?: boolean; apiKey?: string } },
      ][]
    )[0];
    if (!call) throw new Error("updateSettings not called");
    const payload = call[0];
    expect(payload.llm?.clearApiKey).toBe(true);
    expect(payload.llm?.apiKey).toBeUndefined();
  });

  it("sends the expected settings payload when the user edits and saves", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn(async () => ({
      ...VALID_SETTINGS,
      llm: {
        provider: "custom" as const,
        model: "custom-model",
        endpointUrl: "https://example.test/v1",
        hasApiKey: true,
      },
      eligibility: {
        propertyName: "custom_target_flag",
      },
      thresholds: {
        freshnessMaxDays: 21,
        minConfidence: 0.8,
      },
    }));

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    triggerValue(renderer.find(Select, { name: "llmProvider" }), "custom");
    // Custom has an empty catalog — user must pick __other__ and type
    await renderer.waitFor(() => {
      expect(renderer.find(Select, { name: "llmModel" })).toBeTruthy();
    });
    triggerValue(renderer.find(Select, { name: "llmModel" }), "__other__");
    await renderer.waitFor(() => {
      expect(renderer.find(Input, { name: "llmModelOther" })).toBeTruthy();
    });
    triggerValue(renderer.find(Input, { name: "llmModelOther" }), "custom-model");
    triggerValue(renderer.find(Input, { name: "llmEndpointUrl" }), "https://example.test/v1");
    triggerValue(renderer.find(Input, { name: "llmApiKey" }), "custom-secret");
    triggerValue(renderer.find(Input, { name: "exaApiKey" }), "exa-rotated");
    triggerValue(renderer.find(Input, { name: "eligibilityPropertyName" }), "custom_target_flag");
    triggerValue(renderer.find(NumberInput, { name: "freshnessMaxDays" }), 21);
    triggerValue(renderer.find(NumberInput, { name: "minConfidence" }), 80);
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    await renderer.waitFor(() => {
      const text = renderer
        .findAll(Text)
        .map((node) => node.text ?? "")
        .join(" ");
      expect(text).toContain("Settings saved.");
    });

    expect(updateSettings).toHaveBeenCalledWith({
      signalProviders: {
        exa: { enabled: true, apiKey: "exa-rotated" },
        hubspotEnrichment: { enabled: true },
        parallel: { enabled: false },
        trigify: { enabled: false },
      },
      llm: {
        provider: "custom",
        model: "custom-model",
        endpointUrl: "https://example.test/v1",
        apiKey: "custom-secret",
      },
      eligibility: {
        propertyName: "custom_target_flag",
      },
      thresholds: {
        freshnessMaxDays: 21,
        minConfidence: 0.8,
      },
    });
  });

  it("blocks save when the custom llm provider is missing an endpoint url", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn();

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    triggerValue(renderer.find(Select, { name: "llmProvider" }), "custom");
    // endpoint URL field now rendered but untouched (empty)
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      const text = renderer
        .findAll(Text)
        .map((node) => node.text ?? "")
        .join(" ");
      expect(text).toContain("Custom provider requires an endpoint URL.");
    });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("blocks save when __other__ model is selected but the free-text model is empty", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn();

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    triggerValue(renderer.find(Select, { name: "llmModel" }), "__other__");
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      const text = renderer
        .findAll(Text)
        .map((node) => node.text ?? "")
        .join(" ");
      expect(text).toMatch(/model/i);
    });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("sends an explicit llm disable payload when the user selects None", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn(async () => ({
      ...VALID_SETTINGS,
      llm: {
        provider: null,
        model: "",
        hasApiKey: false,
      },
    }));

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    triggerValue(renderer.find(Select, { name: "llmProvider" }), "none");
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    expect(updateSettings).toHaveBeenCalledWith({
      signalProviders: {
        exa: { enabled: true },
        hubspotEnrichment: { enabled: true },
        parallel: { enabled: false },
        trigify: { enabled: false },
      },
      llm: {
        provider: null,
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

  it("renders the initial load error instead of staying on an indefinite loading state", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => {
      throw new Error("settings-fetch-failed: 401 Unauthorized");
    });

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      const text = renderer
        .findAll(Text)
        .map((node) => node.text ?? "")
        .join(" ");
      expect(text).toContain("settings-fetch-failed: 401 Unauthorized");
    });

    const text = renderer
      .findAll(Text)
      .map((node) => node.text ?? "")
      .join(" ");
    expect(text).not.toBe("Loading…");
  });

  it("renders tooltips on Freshness max days and Minimum confidence and displays confidence as a percent", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    const freshnessInput = renderer.find(NumberInput, {
      name: "freshnessMaxDays",
    });
    expect(freshnessInput.props.tooltip).toMatch(/stale/i);

    const minConfidenceInput = renderer.find(NumberInput, {
      name: "minConfidence",
    });
    expect(minConfidenceInput.props.tooltip).toMatch(/confidence/i);
    // Wire value is 0.5; UI shows it as 50 (percent).
    expect(minConfidenceInput.props.value).toBe(50);
    expect(minConfidenceInput.props.label).toMatch(/%/);
  });

  it("preserves the 0..1 decimal wire value for minimum confidence when the user edits via percent", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    const updateSettings = vi.fn(async () => VALID_SETTINGS);

    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    triggerValue(renderer.find(NumberInput, { name: "minConfidence" }), 65);
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    const call = (
      updateSettings.mock.calls[0] as unknown as [{ thresholds: { minConfidence: number } }]
    )[0];
    expect(call.thresholds.minConfidence).toBe(0.65);
  });

  describe("Test-connection buttons", () => {
    const SETTINGS_NO_KEYS = {
      ...VALID_SETTINGS,
      signalProviders: {
        exa: { enabled: true, hasApiKey: false },
        hubspotEnrichment: { enabled: true, hasApiKey: false },
        parallel: { enabled: false, hasApiKey: false },
        trigify: { enabled: false, hasApiKey: false },
      },
      llm: {
        provider: "openai" as const,
        model: "gpt-5.4-mini",
        hasApiKey: false,
      },
    };

    it("disables the Exa Test-connection button when neither a draft nor a saved key exists", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => SETTINGS_NO_KEYS);

      renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      const btn = renderer.findByTestId(Button, "testExaConnection");
      expect(btn.props.disabled).toBe(true);
    });

    it("sends { useSavedKey: true } when clicking Test connection on Exa with no draft key", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 17,
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      renderer.findByTestId(Button, "testExaConnection").trigger("onClick");

      await renderer.waitFor(() => {
        expect(testConnection).toHaveBeenCalledTimes(1);
      });

      expect(testConnection).toHaveBeenCalledWith({
        target: "exa",
        useSavedKey: true,
      });
    });

    it("sends { apiKey } (not useSavedKey) when clicking Test connection on Exa with a draft key", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 11,
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      triggerValue(renderer.find(Input, { name: "exaApiKey" }), "draft-exa-value");
      renderer.findByTestId(Button, "testExaConnection").trigger("onClick");

      await renderer.waitFor(() => {
        expect(testConnection).toHaveBeenCalledTimes(1);
      });

      expect(testConnection).toHaveBeenCalledWith({
        target: "exa",
        apiKey: "draft-exa-value",
      });
    });

    it("disables the LLM Test-connection button when provider is 'none'", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);

      renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      triggerValue(renderer.find(Select, { name: "llmProvider" }), "none");

      await renderer.waitFor(() => {
        const btn = renderer.findByTestId(Button, "testLlmConnection");
        expect(btn.props.disabled).toBe(true);
      });
    });

    it("disables the LLM Test-connection button when provider is 'custom' and endpointUrl is empty", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);

      renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      triggerValue(renderer.find(Select, { name: "llmProvider" }), "custom");
      triggerValue(renderer.find(Select, { name: "llmModel" }), "__other__");
      triggerValue(renderer.find(Input, { name: "llmModelOther" }), "custom-model");

      await renderer.waitFor(() => {
        const btn = renderer.findByTestId(Button, "testLlmConnection");
        expect(btn.props.disabled).toBe(true);
      });
    });

    it("sends provider + model + saved key indicator when clicking Test connection on LLM with no draft key", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 88,
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      renderer.findByTestId(Button, "testLlmConnection").trigger("onClick");

      await renderer.waitFor(() => {
        expect(testConnection).toHaveBeenCalledTimes(1);
      });

      expect(testConnection).toHaveBeenCalledWith({
        target: "llm",
        provider: "openai",
        model: "gpt-5.4-mini",
        useSavedKey: true,
      });
    });

    it("includes endpointUrl in the LLM body when provider is 'custom'", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 12,
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      triggerValue(renderer.find(Select, { name: "llmProvider" }), "custom");
      triggerValue(renderer.find(Select, { name: "llmModel" }), "__other__");
      triggerValue(renderer.find(Input, { name: "llmModelOther" }), "my-model");
      triggerValue(renderer.find(Input, { name: "llmEndpointUrl" }), "https://example.test/v1");
      triggerValue(renderer.find(Input, { name: "llmApiKey" }), "secret-xyz");

      renderer.findByTestId(Button, "testLlmConnection").trigger("onClick");

      await renderer.waitFor(() => {
        expect(testConnection).toHaveBeenCalledTimes(1);
      });

      expect(testConnection).toHaveBeenCalledWith({
        target: "llm",
        provider: "custom",
        model: "my-model",
        endpointUrl: "https://example.test/v1",
        apiKey: "secret-xyz",
      });
    });

    it("renders the latency inline on a successful test-connection response", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 123,
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      renderer.findByTestId(Button, "testExaConnection").trigger("onClick");

      await renderer.waitFor(() => {
        const combined = renderer
          .findAll(Text)
          .map((n) => n.text ?? "")
          .join(" ");
        expect(combined).toContain("123ms");
      });
    });

    it("renders the human-readable message on a failed test-connection response", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: false as const,
        code: "auth" as const,
        message: "rejected",
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      renderer.findByTestId(Button, "testLlmConnection").trigger("onClick");

      await renderer.waitFor(() => {
        const combined = renderer
          .findAll(Text)
          .map((n) => n.text ?? "")
          .join(" ");
        expect(combined).toMatch(/Authentication failed/i);
      });
    });

    it("does NOT clear the status result when the user types in the key input after a result", async () => {
      const renderer = createRenderer("settings");
      const fetchSettings = vi.fn(async () => VALID_SETTINGS);
      const testConnection = vi.fn(async () => ({
        ok: true as const,
        latencyMs: 55,
      }));

      renderer.render(
        <HubSpotSettingsPage fetchSettings={fetchSettings} testConnection={testConnection} />,
      );

      await renderer.waitFor(() => {
        expect(renderer.find(LoadingButton).props.loading).toBe(false);
      });

      renderer.findByTestId(Button, "testExaConnection").trigger("onClick");

      await renderer.waitFor(() => {
        const combined = renderer
          .findAll(Text)
          .map((n) => n.text ?? "")
          .join(" ");
        expect(combined).toContain("55ms");
      });

      // Typing in the key input must NOT re-fire the test and must NOT clear the result.
      triggerValue(renderer.find(Input, { name: "exaApiKey" }), "new-typing");

      // No auto-fire
      expect(testConnection).toHaveBeenCalledTimes(1);
      // Status still present
      const combined = renderer
        .findAll(Text)
        .map((n) => n.text ?? "")
        .join(" ");
      expect(combined).toContain("55ms");
    });
  });
});

describe("Parallel settings control", () => {
  it("shows an anonymous search toggle and sends an explicit disable without an API key", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => ({
      ...VALID_SETTINGS,
      signalProviders: {
        ...VALID_SETTINGS.signalProviders,
        parallel: { enabled: true, hasApiKey: false },
      },
    }));
    const updateSettings = vi.fn(async (_update: unknown) => undefined);
    renderer.render(
      <HubSpotSettingsPage fetchSettings={fetchSettings} updateSettings={updateSettings} />,
    );
    await renderer.waitFor(() =>
      expect(renderer.find(Toggle, { name: "parallelEnabled" }).props.checked).toBe(true),
    );
    expect(
      renderer
        .findAll(Text)
        .map((n) => n.text)
        .join(" "),
    ).toContain("No search API key");
    triggerValue(renderer.find(Toggle, { name: "parallelEnabled" }), false);
    renderer.find(LoadingButton).trigger("onClick");
    await renderer.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      signalProviders: { parallel: { enabled: false } },
    });
  });
});
