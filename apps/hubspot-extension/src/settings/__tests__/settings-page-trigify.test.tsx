import { Heading, LoadingButton } from "@hubspot/ui-extensions";
import { createRenderer } from "@hubspot/ui-extensions/testing";
import { describe, expect, it, vi } from "vitest";
import { HubSpotSettingsPage } from "../settings-page";
import type { TrigifyConnectionResponse, TrigifyMonitor } from "../trigify-types";

const VALID_SETTINGS = {
  tenantId: "tenant-1",
  signalProviders: {
    exa: { enabled: true, hasApiKey: true },
    hubspotEnrichment: { enabled: true, hasApiKey: false },
    parallel: { enabled: false, hasApiKey: false },
    trigify: { enabled: false, hasApiKey: false },
  },
  llm: { provider: "openai" as const, model: "gpt-5.4-mini", hasApiKey: true },
  eligibility: { propertyName: "hs_is_target_account" },
  thresholds: { freshnessMaxDays: 30, minConfidence: 0.5 },
};

const CONNECTED: TrigifyConnectionResponse = {
  connected: true,
  usage: { credits_remaining: 5, monitor_count: 0 },
  monitors: [] as TrigifyMonitor[],
};

function trigifyDeps() {
  return {
    fetchConnection: vi.fn(async () => CONNECTED),
    plan: vi.fn(),
    subscribe: vi.fn(),
    pause: vi.fn(),
    remove: vi.fn(),
  };
}

describe("HubSpotSettingsPage — Trigify section", () => {
  it("renders the Trigify signals section when trigify deps are provided", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} trigify={trigifyDeps()} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    await renderer.waitFor(() => {
      const headings = renderer.findAll(Heading).map((h) => h.text ?? "");
      expect(headings).toContain("Trigify monitors");
    });
  });

  it("does NOT render the Trigify section when trigify deps are omitted (no extra fetch)", async () => {
    const renderer = createRenderer("settings");
    const fetchSettings = vi.fn(async () => VALID_SETTINGS);
    renderer.render(<HubSpotSettingsPage fetchSettings={fetchSettings} />);

    await renderer.waitFor(() => {
      expect(renderer.find(LoadingButton).props.loading).toBe(false);
    });

    const headings = renderer.findAll(Heading).map((h) => h.text ?? "");
    // The always-present key-entry section ("Trigify signals") renders, but the
    // monitors section ("Trigify monitors") only renders with trigify deps.
    expect(headings).not.toContain("Trigify monitors");
  });
});
