import { Button, Input, LoadingButton, Toggle } from "@hubspot/ui-extensions";
import { createRenderer } from "@hubspot/ui-extensions/testing";
import { describe, expect, it, vi } from "vitest";
import { HubSpotSettingsPage } from "../settings-page";

function triggerValue(node: unknown, value: unknown) {
  (node as { trigger: (e: "onChange", v?: unknown) => void }).trigger("onChange", value);
}

const SETTINGS_WITH_KEY = {
  tenantId: "tenant-1",
  signalProviders: {
    exa: { enabled: true, hasApiKey: true },
    hubspotEnrichment: { enabled: true, hasApiKey: false },
    parallel: { enabled: false, hasApiKey: false },
    trigify: { enabled: true, hasApiKey: true },
  },
  llm: { provider: "openai" as const, model: "gpt-5.4-mini", hasApiKey: true },
  eligibility: { propertyName: "hs_is_target_account" },
  thresholds: { freshnessMaxDays: 30, minConfidence: 0.5 },
};

const SETTINGS_NO_TRIGIFY_KEY = {
  ...SETTINGS_WITH_KEY,
  signalProviders: {
    exa: { enabled: true, hasApiKey: true },
    hubspotEnrichment: { enabled: true, hasApiKey: false },
    parallel: { enabled: false, hasApiKey: false },
    trigify: { enabled: false, hasApiKey: false },
  },
};

describe("HubSpotSettingsPage — Trigify key entry", () => {
  it("renders a Trigify enable toggle and API key input", async () => {
    const renderer = createRenderer("settings");
    renderer.render(
      <HubSpotSettingsPage fetchSettings={vi.fn(async () => SETTINGS_NO_TRIGIFY_KEY)} />,
    );
    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });
    expect(renderer.find(Toggle, { name: "trigifyEnabled" })).toBeTruthy();
    expect(renderer.find(Input, { name: "trigifyApiKey" })).toBeTruthy();
  });

  it("shows a stored-key indicator when trigify hasApiKey is true", async () => {
    const renderer = createRenderer("settings");
    renderer.render(<HubSpotSettingsPage fetchSettings={vi.fn(async () => SETTINGS_WITH_KEY)} />);
    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });
    const clearBtn = renderer.findByTestId(Button, "clearTrigifyApiKey");
    expect(clearBtn).toBeTruthy();
  });

  it("saves a rotated trigify key via the signalProviders.trigify leaf", async () => {
    const renderer = createRenderer("settings");
    const updateSettings = vi.fn(async () => SETTINGS_WITH_KEY);
    renderer.render(
      <HubSpotSettingsPage
        fetchSettings={vi.fn(async () => SETTINGS_NO_TRIGIFY_KEY)}
        updateSettings={updateSettings}
      />,
    );
    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    triggerValue(renderer.find(Toggle, { name: "trigifyEnabled" }), true);
    triggerValue(renderer.find(Input, { name: "trigifyApiKey" }), "trigify-secret");
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    const body = (
      updateSettings.mock.calls[0] as unknown as [
        {
          signalProviders?: {
            trigify?: { enabled?: boolean; apiKey?: string };
          };
        },
      ]
    )[0];
    expect(body.signalProviders?.trigify?.enabled).toBe(true);
    expect(body.signalProviders?.trigify?.apiKey).toBe("trigify-secret");
  });

  it("posts clearApiKey:true when the user clears the trigify key", async () => {
    const renderer = createRenderer("settings");
    const updateSettings = vi.fn(async () => SETTINGS_WITH_KEY);
    renderer.render(
      <HubSpotSettingsPage
        fetchSettings={vi.fn(async () => SETTINGS_WITH_KEY)}
        updateSettings={updateSettings}
      />,
    );
    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    renderer.findByTestId(Button, "clearTrigifyApiKey").trigger("onClick");
    renderer.find(LoadingButton).trigger("onClick");

    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    const body = (
      updateSettings.mock.calls[0] as unknown as [
        {
          signalProviders?: {
            trigify?: { clearApiKey?: boolean; apiKey?: string };
          };
        },
      ]
    )[0];
    expect(body.signalProviders?.trigify?.clearApiKey).toBe(true);
    expect(body.signalProviders?.trigify?.apiKey).toBeUndefined();
  });

  it("does not send a trigify apiKey when the field is left blank (preserve existing)", async () => {
    const renderer = createRenderer("settings");
    const updateSettings = vi.fn(async () => SETTINGS_WITH_KEY);
    renderer.render(
      <HubSpotSettingsPage
        fetchSettings={vi.fn(async () => SETTINGS_WITH_KEY)}
        updateSettings={updateSettings}
      />,
    );
    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    renderer.find(LoadingButton).trigger("onClick");
    await renderer.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    const body = (
      updateSettings.mock.calls[0] as unknown as [
        {
          signalProviders?: {
            trigify?: {
              enabled?: boolean;
              apiKey?: string;
              clearApiKey?: boolean;
            };
          };
        },
      ]
    )[0];
    expect(body.signalProviders?.trigify?.apiKey).toBeUndefined();
    expect(body.signalProviders?.trigify?.clearApiKey).toBeUndefined();
    // enabled is still round-tripped
    expect(body.signalProviders?.trigify?.enabled).toBe(true);
  });
});
