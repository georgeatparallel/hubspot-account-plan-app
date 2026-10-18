/**
 * Snapshot assembler.
 *
 * Pipeline for V1 (Slice 1):
 *   1. eligibility gate (`checkEligibility`)
 *      - ineligible   → ineligible snapshot, empty people/evidence
 *      - unconfigured → unconfigured snapshot, empty people/evidence
 *   2. fetch signals via the injected {@link ProviderAdapter}
 *   3. extract dominant signal (freshness + confidence thresholds)
 *      - none → eligible + `stateFlags.empty = true`, no reason, no people
 *   4. generate reason text (template; optional LLM rephrase)
 *   5. fetch + rank + select people (0..3, never fabricate)
 *   6. assemble Snapshot with caller tenantId stamped everywhere
 *
 * Trust + suppression now run between signal fetch and reason generation.
 * The assembler keeps that seam explicit so future hygiene changes can slot in
 * without changing the route or adapter contracts.
 *
 * Tenant isolation: `tenantId` is ALWAYS sourced from the `args.tenantId`
 * parameter. Adapters / fetchers may not override it — evidence rows are
 * re-stamped via `createSnapshot` if any drift slips through.
 */

import {
  createSnapshot,
  createStateFlags,
  type Evidence,
  type Person,
  type Snapshot,
  type ThresholdConfig,
} from "@hap/config";
import type { Database } from "@hap/db";
import type { LlmAdapter } from "../adapters/llm-adapter.js";
import type { ProviderAdapter } from "../adapters/provider-adapter.js";
import { TenantAccessRevokedError } from "../lib/hubspot-client.js";
import { type CompanyPropertyFetcher, checkEligibility } from "./eligibility.js";
import { dedupEvidence } from "./hygiene/dedup.js";
import { sweepStaleness } from "./hygiene/staleness-sweeper.js";
import { generateNextMove } from "./next-move.js";
import {
  type ContactFetcher,
  fetchContacts,
  rankContacts,
  selectPeople,
} from "./people-selector.js";
import { extractDominantSignal, generateReasonText } from "./reason-generator.js";
import { createTrustEvaluator, type TrustEvaluator } from "./trust.js";

export type AssembleSnapshotDeps = {
  db: Database;
  providerAdapter: ProviderAdapter;
  llmAdapter?: LlmAdapter;
  propertyFetcher: CompanyPropertyFetcher;
  contactFetcher: ContactFetcher;
  thresholds: ThresholdConfig;
  /**
   * Optional trust evaluator. Defaults to `createTrustEvaluator()` when omitted;
   * tests may inject a stub to exercise specific suppression paths.
   */
  trustEvaluator?: TrustEvaluator;
  /**
   * Optional per-provider allow-list of source domains. Passed through to
   * the trust evaluator's {@link TrustEvaluator.applyAllowBlockLists} hook
   * AFTER dedup + staleness but BEFORE the trust suppression flow. Subdomain
   * matching via `endsWith` is the responsibility of that method. Restricted
   * state still short-circuits earlier.
   */
  allowList?: string[];
  /** Optional per-provider block-list; block always wins over allow. */
  blockList?: string[];
  /** Optional clock override for deterministic tests. */
  now?: Date;
  /**
   * Optional correlation ID forwarded to downstream LLM observability on
   * the next-move stage. When the assembler is called from the snapshot
   * route this is the request correlation ID; tests may omit it.
   */
  correlationId?: string;
};

export type AssembleSnapshotArgs = {
  tenantId: string;
  companyId: string;
  signal?: AbortSignal;
};

export async function assembleSnapshot(
  deps: AssembleSnapshotDeps,
  args: AssembleSnapshotArgs,
): Promise<Snapshot> {
  const { tenantId, companyId } = args;
  args.signal?.throwIfAborted();
  const now = deps.now ?? new Date();

  // 1. Eligibility gate.
  const eligibility = await checkEligibility(
    { db: deps.db, fetcher: deps.propertyFetcher },
    { tenantId, companyId },
  );

  if (eligibility.reason === "ineligible") {
    return createSnapshot(tenantId, {
      companyId,
      eligibilityState: "ineligible",
      reasonToContact: undefined,
      people: [],
      evidence: [],
      stateFlags: createStateFlags({ ineligible: true }),
      createdAt: now,
    });
  }

  if (eligibility.reason === "unconfigured") {
    return createSnapshot(tenantId, {
      companyId,
      eligibilityState: "unconfigured",
      reasonToContact: undefined,
      people: [],
      evidence: [],
      stateFlags: createStateFlags(),
      createdAt: now,
    });
  }

  // 2. Fetch signals (eligible path).
  let signals: Evidence[] = [];
  let transportDegraded = false;
  try {
    signals = args.signal
      ? await deps.providerAdapter.fetchSignals(tenantId, { companyId }, { signal: args.signal })
      : await deps.providerAdapter.fetchSignals(tenantId, { companyId });
    args.signal?.throwIfAborted();
  } catch (err) {
    if (args.signal?.aborted || err instanceof TenantAccessRevokedError) {
      throw err;
    }
    // Transport error → mark degraded; continue with empty signal set.
    // Log a STABLE error code/class only — never the raw message. External
    // adapter errors can smuggle request URLs, tenant data, or auth material
    // straight into shared logs. The class name is enough to grep for; the
    // raw text stays in any structured observability sink behind a debug gate.
    console.warn("snapshot_assembler.signal_adapter_failed", {
      tenantId,
      companyId,
      adapter: deps.providerAdapter.name,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
    transportDegraded = true;
    signals = [];
  }

  const trust = deps.trustEvaluator ?? createTrustEvaluator();

  // 3a. Restricted-state zero-leak SHORT-CIRCUIT — runs BEFORE any hygiene
  //     stage so no restricted row can leak into dedup / staleness /
  //     allow-block logs, caches, or intermediate buffers. If ANY restricted
  //     evidence was present, the response must not contain any evidence,
  //     people, reason, or trustScore derived from ANY source in this
  //     request. The only signal surfaced is `restricted=true`.
  const hasRestricted = signals.some((ev) => ev.isRestricted === true);
  if (hasRestricted) {
    return createSnapshot(tenantId, {
      companyId,
      eligibilityState: "eligible",
      reasonToContact: undefined,
      people: [],
      evidence: [],
      stateFlags: createStateFlags({ restricted: true }),
      trustScore: undefined,
      createdAt: now,
    });
  }

  // 3b. Hygiene: dedup → staleness classification → per-provider allow/block.
  //     - dedup collapses cross-provider duplicates.
  //     - sweepStaleness CLASSIFIES rows into fresh/stale. We pass both
  //       forward to applySuppression (Slice 1 contract: stale rows are
  //       SUPPRESSED via flag, not dropped from `filteredEvidence`). We do,
  //       however, track `sawStale` defensively so the flag still fires even
  //       if allow/block drops every stale row afterward.
  //     - allow/block runs on the deduped set — the tenant's explicit
  //       domain policy applies uniformly regardless of age.
  //     All stages are order-preserving within the survivor set.
  const deduped = dedupEvidence(signals);
  const swept = sweepStaleness(deduped, deps.thresholds, () => now);
  const sawStale = swept.stale.length > 0;
  const afterAllowBlock = trust.applyAllowBlockLists(deduped, {
    allow: deps.allowList,
    block: deps.blockList,
  });

  // 3c. Trust + suppression. `restricted` cannot fire here — we already
  //     returned above. Remaining flags (lowConfidence / degraded / empty)
  //     come from this call.
  const suppression = trust.applySuppression(afterAllowBlock, deps.thresholds, now);

  // Merge transport-level degraded flag with source-validation degraded flag.
  const degraded = suppression.stateFlags.degraded || transportDegraded;
  const stale = suppression.stateFlags.stale || sawStale;

  // 4. Dominant signal extraction (from filtered evidence only).
  const dominant = extractDominantSignal(suppression.filteredEvidence, deps.thresholds, now);

  if (!dominant) {
    return createSnapshot(tenantId, {
      companyId,
      eligibilityState: "eligible",
      reasonToContact: undefined,
      people: [],
      evidence: suppression.filteredEvidence,
      stateFlags: createStateFlags({
        empty: true,
        degraded,
        stale,
        lowConfidence: suppression.stateFlags.lowConfidence,
      }),
      createdAt: now,
    });
  }

  // 5. Reason text.
  const reasonToContact = await generateReasonText(dominant, deps.llmAdapter);

  // 6. Contacts → ranked → selected.
  const contacts = await fetchContacts({ fetcher: deps.contactFetcher }, { tenantId, companyId });
  const ranked = rankContacts(contacts, dominant);
  const people: Person[] = selectPeople(ranked, dominant);

  const assembled = createSnapshot(tenantId, {
    companyId,
    eligibilityState: "eligible",
    reasonToContact,
    people,
    evidence: suppression.filteredEvidence,
    stateFlags: createStateFlags({
      degraded,
      stale,
      lowConfidence: suppression.stateFlags.lowConfidence,
      empty: false,
    }),
    createdAt: now,
  });

  // 7. Next-move recommendation (Step 13). Best-effort — never blocks
  //    the snapshot response. Skipped when no LLM adapter is wired OR the
  //    resolved adapter is the mock fallback: running a real LLM call for
  //    a mock-only tenant burns budget for zero product value (Slice 3
  //    removes the mock fallback entirely).
  //
  //    The zero-leak short-circuit lives inside `generateNextMove`; the
  //    assembler does not duplicate those checks so there is exactly one
  //    audited boundary.
  if (deps.llmAdapter && deps.llmAdapter.provider !== "mock-llm") {
    // Best-effort — MUST NOT block the snapshot response. If the LLM call
    // throws (network error, rate limit, malformed response, etc), we log
    // via observability (already wrapped inside generateNextMove) and leave
    // `assembled.nextMove` undefined. The card then hides gracefully in the UI.
    try {
      const nextMove = await generateNextMove({
        snapshot: assembled,
        llmAdapter: deps.llmAdapter,
        correlationId: deps.correlationId,
      });
      if (nextMove !== null) {
        assembled.nextMove = nextMove;
      }
    } catch {
      // Swallow. generateNextMove's own failure path also returns null on
      // thrown errors, so this is defense-in-depth for any error that
      // escapes the wrapper.
    }
  }

  return assembled;
}
