/**
 * Oberlin Calendar Automation — pipeline orchestration
 * ----------------------------------------------------
 * Implements the multi-agent flow described in the AI Micro-Grant pilot: unify
 * distributed public calendars into staging records that match the Environmental
 * Dashboard / Community Hub submission shape, then human-review before publish.
 *
 * Stage order (typical):
 *   1. Listing collector — browser_listing_v1 | openai_listing_v1 | localist | ics
 *   2. Detail extractor   — agentDetail (MCP + LLM) → full form fields + completeness
 *   3. Hyperlocal tagger  — agentHyperlocal → geographic scope + tags
 *   4. Dedupe comparator — agentDedupe → duplicate of staging or hub snapshot
 *   5. Quality gate      — agentQualityGate → required fields + URL/image checks
 *   6. Repair agent      — agentRepair → optional re-extraction for fixable issues
 *
 * Reviewer rejections and QA failures feed agent_feedback → getAgentPromptGuidance()
 * for the next extraction/tag/dedupe prompts.
 *
 * @see README.md — “Agent roster” for fault_agent keys and module map.
 */
import fs from "node:fs";

import { syncCommunityHubCalendarFromBrowser } from "./adapters/agentHubSnapshot.js";
import { syncCommunityHubFromLegacyApi } from "./adapters/communityHubLegacyApi.js";
import { extractDashboardEventFromCandidate } from "./adapters/agentDetail.js";
import { runOpenAiListingAdapter } from "./adapters/agentListing.js";
import { runBrowserListingAdapter } from "./adapters/browser.js";
import { runIcsAdapter } from "./adapters/ics.js";
import { runLocalistAdapter } from "./adapters/localist.js";
import { runHeritageCenterAdapter } from "./adapters/heritageCenterAdapter.js";
import { runAMAMAdapter } from "./adapters/amamAdapter.js";
import { runFAVAAdapter } from "./adapters/favaAdapter.js";
import { buildDedupeContext, runDuplicateCompareAgent } from "./agents/agentDedupe.js";
import { runHyperlocalAgent } from "./agents/agentHyperlocal.js";
import { runQualityGateAgent } from "./agents/agentQualityGate.js";
import { runRepairAgent } from "./agents/agentRepair.js";
import { parseJson, nowIso, sleep, isEventStartInPast } from "./utils.js";

/* ── Agent activity log ──────────────────────────────────────────────────────
 * In-memory ring buffer of recent agent activity (last 200 entries).
 * Cleared on restart; exposed via GET /api/agent-activity so the dashboard
 * can show live status without SSE complexity.
 */
const ACTIVITY_LOG_MAX = 200;
export const agentActivityLog = [];

function logActivity(entry) {
  agentActivityLog.push({ ts: nowIso(), ...entry });
  if (agentActivityLog.length > ACTIVITY_LOG_MAX) {
    agentActivityLog.splice(0, agentActivityLog.length - ACTIVITY_LOG_MAX);
  }
}

/** Pilot research: skip LLM-heavy steps and human review when the event already started. */
function applyPastEventResearchSkip(event, runtimeConfig) {
  if (!runtimeConfig.skipPastEventsForPipeline) {
    return false;
  }
  const graceMs = Math.max(0, Number(runtimeConfig.pastEventGraceHours || 0)) * 3600 * 1000;
  if (!isEventStartInPast(event?.start_datetime, graceMs)) {
    return false;
  }
  event.review_status = "rejected";
  event.extraction_metadata = {
    ...(event.extraction_metadata || {}),
    qa_status: "skipped",
    auto_reject_reason: "event_start_in_past",
    research_note:
      "Pilot filter: start time is before the evaluation window. Adjust PAST_EVENT_GRACE_HOURS or set SKIP_PAST_EVENTS=false."
  };
  logActivity({
    type: "research_skip_past",
    title: event.title,
    start: event.start_datetime
  });
  return true;
}

function shouldExtractEventDetails(source, result) {
  if ((result.stagedEvents || []).length > 0) {
    return false;
  }
  if (!(result.candidates || []).length) {
    return false;
  }
  if (source.adapter_key !== "openai_listing_v1") {
    return false;
  }
  return source.adapter_config?.extract_event_details !== false;
}

function mergeRepairIntoEvent(target, repaired) {
  for (const field of [
    "title",
    "organizational_sponsor",
    "start_datetime",
    "end_datetime",
    "location_type",
    "location_or_address",
    "room_number",
    "event_link",
    "short_description",
    "extended_description",
    "artwork_url",
    "community_hub_payload"
  ]) {
    if (repaired[field] !== undefined && repaired[field] !== null) {
      target[field] = repaired[field];
    }
  }
}

async function runQaRepairLoop({ repository, source, event, runtimeConfig, detailFeedback }) {
  const qa = await runQualityGateAgent(event, runtimeConfig);
  if (qa.passed) {
    event.extraction_metadata = {
      ...(event.extraction_metadata || {}),
      qa_status: "pass"
    };
    return { status: "pass", issues: [] };
  }

  logActivity({ type: "qa_fail", title: event.title, issues: qa.issues.length });
  for (const issue of qa.issues) {
    repository.addAgentFeedback({
      staging_event_id: event.id || event.source_event_url || "pending",
      source_id: source.id,
      fault_agent: issue.fault_agent || "other",
      rejection_reason: issue.message,
      reviewer_name: "qa_agent"
    });
  }

  const repair = await runRepairAgent(source, event, qa.issues, runtimeConfig, detailFeedback);
  if (repair.attempted && repair.repairedEvent) {
    mergeRepairIntoEvent(event, repair.repairedEvent);
    const qaAfterRepair = await runQualityGateAgent(event, runtimeConfig);
    if (qaAfterRepair.passed) {
      event.extraction_metadata = {
        ...(event.extraction_metadata || {}),
        qa_status: "repaired_pass"
      };
      logActivity({ type: "qa_repaired", title: event.title });
      return { status: "repaired_pass", issues: [] };
    }

    event.review_status = "rejected";
    event.extraction_metadata = {
      ...(event.extraction_metadata || {}),
      qa_status: "rejected",
      qa_issues: qaAfterRepair.issues
    };
    logActivity({ type: "qa_reject", title: event.title, issues: qaAfterRepair.issues.length });
    return { status: "rejected", issues: qaAfterRepair.issues };
  }

  event.review_status = "rejected";
  event.extraction_metadata = {
    ...(event.extraction_metadata || {}),
    qa_status: "rejected",
    qa_issues: qa.issues
  };
  logActivity({ type: "qa_reject", title: event.title, issues: qa.issues.length });
  return { status: "rejected", issues: qa.issues };
}

const adapters = {
  browser_listing_v1: runBrowserListingAdapter,
  openai_listing_v1: runOpenAiListingAdapter,
  ics_v1: runIcsAdapter,
  localist_v1: runLocalistAdapter,
  heritage_center_v1: runHeritageCenterAdapter,
  amam_camoufox_v1: runAMAMAdapter,
  fava_v1: runFAVAAdapter
};

/** Merge one-off adapter_config keys for a single run (does not persist to DB). */
function sourceWithRunAdapterPatch(sourceRecord, patch) {
  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
    return sourceRecord;
  }
  return {
    ...sourceRecord,
    adapter_config: {
      ...(sourceRecord.adapter_config || {}),
      ...patch
    }
  };
}

// How often the hub snapshot is refreshed (default 1 h). Override via HUB_SYNC_INTERVAL_MS.
// When runtimeConfig.communityHubSyncDayOfWeek is set, interval is ignored and sync fires
// once per calendar day only on that weekday (0=Sun … 5=Fri … 6=Sat).
const HUB_SYNC_INTERVAL_MS = Number(process.env.HUB_SYNC_INTERVAL_MS || 60 * 60 * 1000);

export function createAutomationService(repository, runtimeConfig) {
  const runningSources = new Set();
  let hubLastSyncedAt = null; // in-process memory — resets on restart (intentional)

  /**
   * Refresh community_hub_events for dedupe: prefers Community Hub legacy JSON when
   * `communityHubLegacyPostsUrl` is set (no OpenAI/MCP). Otherwise uses browser snapshot
   * when OPENAI_API_KEY and MCP_BROWSER_URL are set.
   *
   * Scheduling: if `communityHubSyncDayOfWeek` is set (e.g. 5 = Friday), syncs at most
   * once per calendar day and only on that weekday (America/New_York).
   * Otherwise falls back to interval-based throttle (HUB_SYNC_INTERVAL_MS).
   */
  async function syncHubIfStale() {
    const now = Date.now();
    const syncDay = runtimeConfig.communityHubSyncDayOfWeek;

    if (syncDay != null) {
      // Day-of-week mode: only sync on the configured weekday, at most once per calendar day.
      const tz = "America/New_York";
      const nowDate = new Date(now);
      const localParts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(nowDate);
      const dayOfWeek = nowDate.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
      // Map abbreviated weekday to 0-6 (Sun=0, Mon=1, … Sat=6)
      const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const currentDow = DAY_MAP[dayOfWeek];

      if (currentDow !== syncDay) {
        return false; // Not the configured weekday
      }

      // Build a "today" string in local time (YYYY-MM-DD) to detect same-day repeat
      const todayLocal = localParts
        .filter((p) => ["year", "month", "day"].includes(p.type))
        .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
      const todayStr = `${todayLocal.year}-${todayLocal.month}-${todayLocal.day}`;

      if (hubLastSyncedAt) {
        const lastDate = new Date(hubLastSyncedAt).toLocaleDateString("en-US", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        });
        // lastDate is m/d/yyyy — reformat to match
        const [lm, ld, ly] = lastDate.split("/");
        const lastStr = `${ly}-${lm}-${ld}`;
        if (lastStr === todayStr) {
          return false; // Already ran today
        }
      }
    } else {
      // Interval mode
      if (hubLastSyncedAt && now - hubLastSyncedAt < HUB_SYNC_INTERVAL_MS) {
        return false;
      }
    }

    const legacyUrl = runtimeConfig.communityHubLegacyPostsUrl;
    if (legacyUrl) {
      try {
        const result = await syncCommunityHubFromLegacyApi(repository, runtimeConfig);
        hubLastSyncedAt = Date.now();
        console.log(
          `hub legacy API sync — parsed ${result.parsed_count} (inserted ${result.inserted}, updated ${result.updated})`
        );
        return true;
      } catch (err) {
        console.error("hub legacy API sync failed:", err.message);
        return false;
      }
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const mcpUrl = (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
    if (!apiKey || !mcpUrl) {
      return false;
    }
    try {
      const result = await syncCommunityHubCalendarFromBrowser(repository, runtimeConfig);
      hubLastSyncedAt = Date.now();
      console.log(
        `hub browser sync complete — parsed ${result.parsed_count} events (inserted ${result.inserted}, updated ${result.updated})`
      );
      return true;
    } catch (err) {
      console.error("hub auto-sync failed:", err.message);
      return false;
    }
  }

  function loadSeedSources() {
    try {
      return parseJson(fs.readFileSync(runtimeConfig.seedSourcesPath, "utf8"), []);
    } catch {
      return [];
    }
  }

  function seedIfEnabled() {
    if (!runtimeConfig.autoSeedSources) {
      return 0;
    }

    const seedSources = loadSeedSources();
    return repository.seedSourcesIfEmpty(seedSources);
  }

  /**
   * @param {string} sourceId
   * @param {object} [runOptions]
   * @param {Record<string, unknown>} [runOptions.adapter_config] One-off overrides merged into the
   *   source's saved adapter_config for this run only (e.g. max_links, max_detail_extractions).
   */
  async function processSource(sourceId, runOptions = {}) {
    if (runningSources.has(sourceId)) {
      return { status: "skipped", reason: "already_running" };
    }

    const sourceRow = repository.getSource(sourceId);
    if (!sourceRow) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    const source = sourceWithRunAdapterPatch(sourceRow, runOptions.adapter_config);

    const adapter = adapters[source.adapter_key];
    if (!adapter) {
      throw new Error(`Unsupported adapter: ${source.adapter_key}`);
    }

    runningSources.add(sourceId);
    const runId = repository.beginRun(sourceId);
    let newCandidates = 0;
    let upsertedEvents = 0;

    logActivity({ type: "source_start", source: source.source_name, adapter: source.adapter_key });

    try {
      const result = await adapter(source, runtimeConfig);
      const candidateCount = (result.candidates || []).length;
      logActivity({ type: "listing_done", source: source.source_name, candidates: candidateCount });

      const stagedEvents = [...(result.stagedEvents || [])];
      const baseStagedCount = stagedEvents.length;
      const detailFeedback = repository.getAgentPromptGuidance("detail_extractor", 8);
      const hyperlocalFeedback = repository.getAgentPromptGuidance("hyperlocal_agent", 8);
      const dedupeFeedback = repository.getAgentPromptGuidance("dedupe_agent", 8);

      if (shouldExtractEventDetails(source, result)) {
        const maxDetail = Number(source.adapter_config?.max_detail_extractions ?? 25);
        let extracted = 0;
        for (const candidate of result.candidates || []) {
          if (extracted >= maxDetail) {
            break;
          }
          logActivity({ type: "detail_start", source: source.source_name, url: candidate.event_url, title: candidate.title_hint || null });
          try {
            const evt = await extractDashboardEventFromCandidate(
              source,
              candidate,
              runtimeConfig,
              detailFeedback
            );
            stagedEvents.push(evt);
            extracted += 1;
            logActivity({ type: "detail_done", source: source.source_name, title: evt.title || candidate.title_hint });
          } catch (err) {
            logActivity({ type: "detail_error", source: source.source_name, url: candidate.event_url, error: err.message });
            console.error("event detail extraction failed", candidate.event_url, err.message);
          }
          await sleep(runtimeConfig.detailExtractionDelayMs ?? 1500);
        }
      }

      const detailExtractionsAdded = stagedEvents.length - baseStagedCount;

      for (const candidate of result.candidates || []) {
        const upsert = repository.upsertCandidate(source.id, candidate);
        if (upsert.inserted) {
          newCandidates += 1;
        }
      }

      for (const event of stagedEvents) {
        const skippedPast = applyPastEventResearchSkip(event, runtimeConfig);
        if (!skippedPast) {
          // --- Agent 3: Hyperlocal classifier (no browser — pure text, cheap) ---
          if (process.env.OPENAI_API_KEY?.trim()) {
            logActivity({ type: "hyperlocal_start", title: event.title });
            try {
              const geo = await runHyperlocalAgent(event, runtimeConfig, hyperlocalFeedback);
              event.hyperlocal_scope = geo.scope;
              event.geographic_tags = geo.geographic_tags;
              logActivity({ type: "hyperlocal_done", title: event.title, scope: geo.scope });
            } catch (err) {
              console.error("hyperlocal agent failed for", event.title, err.message);
              logActivity({ type: "hyperlocal_error", title: event.title, error: err.message });
              event.hyperlocal_scope = null;
              event.geographic_tags = [];
            }
          }

          let duplicateMatch = repository.findDuplicateMatch(event, source.id);

          if (
            !duplicateMatch.is_duplicate &&
            runtimeConfig.openaiDedupeEnabled &&
            process.env.OPENAI_API_KEY?.trim()
          ) {
            logActivity({ type: "dedupe_start", title: event.title });
            try {
              const ctx = buildDedupeContext(
                repository,
                source.id,
                runtimeConfig.openaiDedupeContextLimit
              );
              const llm = await runDuplicateCompareAgent(event, ctx, runtimeConfig, dedupeFeedback);
              if (llm.applied && llm.is_duplicate) {
                duplicateMatch = {
                  is_duplicate: true,
                  duplicate_match_url: llm.duplicate_match_url,
                  duplicate_reason: llm.duplicate_reason
                };
                logActivity({ type: "dedupe_done", title: event.title, is_duplicate: true, reason: llm.duplicate_reason });
              } else {
                logActivity({ type: "dedupe_done", title: event.title, is_duplicate: false });
              }
            } catch (err) {
              logActivity({ type: "dedupe_error", title: event.title, error: err.message });
              console.error("duplicate compare agent failed", err.message);
            }
          }

          event.is_duplicate = duplicateMatch.is_duplicate;
          event.duplicate_match_url = duplicateMatch.duplicate_match_url;
          event.duplicate_reason = duplicateMatch.duplicate_reason;
          event.community_hub_payload.is_duplicate = event.is_duplicate;
          event.community_hub_payload.duplicate_match_url = event.duplicate_match_url;

          await runQaRepairLoop({
            repository,
            source,
            event,
            runtimeConfig,
            detailFeedback
          });
        } else {
          event.is_duplicate = false;
          event.duplicate_match_url = null;
          event.duplicate_reason = null;
          event.community_hub_payload = event.community_hub_payload || {};
          event.community_hub_payload.is_duplicate = false;
          event.community_hub_payload.duplicate_match_url = null;
        }

        const sourceCandidate =
          result.candidates?.find((candidate) => candidate.event_url === event.source_event_url) || null;
        const candidateUpsert =
          sourceCandidate && repository.upsertCandidate(source.id, sourceCandidate);
        const stagingUpsert = repository.upsertStagingEvent(
          source.id,
          candidateUpsert?.record?.id || null,
          event
        );
        if (stagingUpsert.inserted) {
          upsertedEvents += 1;
        }
      }

      logActivity({ type: "source_done", source: source.source_name, new_candidates: newCandidates, upserted_events: upsertedEvents });

      repository.finishRun(runId, {
        status: "success",
        new_candidates: newCandidates,
        upserted_events: upsertedEvents,
        summary: {
          ...(result.summary || {}),
          detail_extractions: detailExtractionsAdded,
          research_experiment_id: runtimeConfig.researchExperimentId || null,
          skip_past_events: runtimeConfig.skipPastEventsForPipeline
        }
      });
      repository.markSourceRunResult(source.id, "success", null, source.poll_interval_minutes);

      return {
        status: "success",
        source_id: source.id,
        new_candidates: newCandidates,
        upserted_events: upsertedEvents,
        adapter_config_applied: source.adapter_config || {},
        summary: {
          ...(result.summary || {}),
          detail_extractions: detailExtractionsAdded,
          research_experiment_id: runtimeConfig.researchExperimentId || null,
          skip_past_events: runtimeConfig.skipPastEventsForPipeline
        }
      };
    } catch (error) {
      logActivity({ type: "source_error", source: source.source_name, error: error.message });
      repository.finishRun(runId, {
        status: "failed",
        new_candidates: newCandidates,
        upserted_events: upsertedEvents,
        error_message: error.message,
        summary: {}
      });
      repository.markSourceRunResult(source.id, "failed", error.message, source.poll_interval_minutes);
      throw error;
    } finally {
      runningSources.delete(sourceId);
    }
  }

  /**
   * Incremental watch — runs the listing agent for one source, compares discovered
   * fingerprints against what's already in event_candidates, then runs the full
   * detail→hyperlocal→dedup pipeline ONLY for genuinely new URLs.
   *
   * Much cheaper than a full processSource run when no new events have appeared.
   */
  async function processSourceIncremental(sourceId) {
    if (runningSources.has(sourceId)) {
      return { status: "skipped", reason: "already_running" };
    }

    const source = repository.getSource(sourceId);
    if (!source) return { status: "error", reason: "not_found" };
    if (!source.is_active) return { status: "skipped", reason: "inactive" };

    const adapter = adapters[source.adapter_key];
    if (!adapter) return { status: "skipped", reason: "unsupported_adapter" };

    runningSources.add(sourceId);
    logActivity({ type: "watch_start", source: source.source_name });

    try {
      // Step 1: Run the adapter to get current event list
      const result = await adapter(source, runtimeConfig);
      const allCandidates = result.candidates || [];
      const adapterStagedEvents = result.stagedEvents || [];

      // ICS / Localist adapters return staged events directly — for these we
      // count truly new inserts (upsert returns inserted:true) as the "new" signal.
      if (adapterStagedEvents.length > 0 && allCandidates.length === 0) {
        await syncHubIfStale();
        let newCount = 0;
        for (const event of adapterStagedEvents) {
          applyPastEventResearchSkip(event, runtimeConfig);
          const stagingUpsert = repository.upsertStagingEvent(source.id, null, event);
          if (stagingUpsert.inserted) newCount++;
        }
        if (newCount === 0) {
          logActivity({ type: "watch_none", source: source.source_name, checked: adapterStagedEvents.length });
          return { status: "no_new_events", checked: adapterStagedEvents.length };
        }
        logActivity({ type: "watch_done", source: source.source_name, new_found: newCount, extracted: newCount });
        return { status: "new_events_extracted", new_count: newCount, extracted: newCount };
      }

      // Step 2: Diff discovered fingerprints vs DB
      const knownFingerprints = repository.getKnownFingerprints(sourceId);
      const newCandidates = allCandidates.filter(c => !knownFingerprints.has(c.fingerprint));

      // Always refresh seen timestamps for all candidates
      for (const c of allCandidates) repository.upsertCandidate(source.id, c);

      if (newCandidates.length === 0) {
        logActivity({ type: "watch_none", source: source.source_name, checked: allCandidates.length });
        return { status: "no_new_events", checked: allCandidates.length };
      }

      logActivity({
        type: "watch_new_found",
        source: source.source_name,
        new_count: newCandidates.length,
        total: allCandidates.length
      });

      // Step 3: Sync hub so dedup memory is fresh
      await syncHubIfStale();

      // Step 4: Run detail→hyperlocal→dedup only for new candidates
      let extracted = 0;
      const maxDetail = Number(source.adapter_config?.max_detail_extractions ?? 25);
      const shouldExtract =
        source.adapter_key === "openai_listing_v1" &&
        source.adapter_config?.extract_event_details !== false;
      const detailFeedback = repository.getAgentPromptGuidance("detail_extractor", 8);
      const hyperlocalFeedback = repository.getAgentPromptGuidance("hyperlocal_agent", 8);
      const dedupeFeedback = repository.getAgentPromptGuidance("dedupe_agent", 8);

      for (const candidate of newCandidates) {
        if (extracted >= maxDetail) break;
        if (!shouldExtract) continue;

        logActivity({ type: "detail_start", source: source.source_name, url: candidate.event_url, title: candidate.title_hint || null });
        let event;
        try {
          event = await extractDashboardEventFromCandidate(source, candidate, runtimeConfig, detailFeedback);
          extracted++;
          logActivity({ type: "detail_done", source: source.source_name, title: event.title });
        } catch (err) {
          logActivity({ type: "detail_error", source: source.source_name, url: candidate.event_url, error: err.message });
          console.error("watch: detail extraction failed", candidate.event_url, err.message);
          await sleep(runtimeConfig.detailExtractionDelayMs ?? 1500);
          continue;
        }

        const skippedPast = applyPastEventResearchSkip(event, runtimeConfig);
        if (!skippedPast) {
          // Agent 3: Hyperlocal
          if (process.env.OPENAI_API_KEY?.trim()) {
            logActivity({ type: "hyperlocal_start", title: event.title });
            try {
              const geo = await runHyperlocalAgent(event, runtimeConfig, hyperlocalFeedback);
              event.hyperlocal_scope = geo.scope;
              event.geographic_tags  = geo.geographic_tags;
              logActivity({ type: "hyperlocal_done", title: event.title, scope: geo.scope });
            } catch (err) {
              event.hyperlocal_scope = null;
              event.geographic_tags  = [];
              logActivity({ type: "hyperlocal_error", title: event.title, error: err.message });
            }
          }

          // Agent 4: Dedup
          let duplicateMatch = repository.findDuplicateMatch(event, source.id);
          if (
            !duplicateMatch.is_duplicate &&
            runtimeConfig.openaiDedupeEnabled &&
            process.env.OPENAI_API_KEY?.trim()
          ) {
            logActivity({ type: "dedupe_start", title: event.title });
            try {
              const ctx = buildDedupeContext(repository, source.id, runtimeConfig.openaiDedupeContextLimit);
              const llm = await runDuplicateCompareAgent(event, ctx, runtimeConfig, dedupeFeedback);
              if (llm.applied && llm.is_duplicate) {
                duplicateMatch = { is_duplicate: true, duplicate_match_url: llm.duplicate_match_url, duplicate_reason: llm.duplicate_reason };
                logActivity({ type: "dedupe_done", title: event.title, is_duplicate: true, reason: llm.duplicate_reason });
              } else {
                logActivity({ type: "dedupe_done", title: event.title, is_duplicate: false });
              }
            } catch (err) {
              logActivity({ type: "dedupe_error", title: event.title, error: err.message });
              console.error("watch: dedup agent failed", err.message);
            }
          }

          event.is_duplicate          = duplicateMatch.is_duplicate;
          event.duplicate_match_url   = duplicateMatch.duplicate_match_url;
          event.duplicate_reason      = duplicateMatch.duplicate_reason;
          event.community_hub_payload.is_duplicate        = event.is_duplicate;
          event.community_hub_payload.duplicate_match_url = event.duplicate_match_url;

          await runQaRepairLoop({
            repository,
            source,
            event,
            runtimeConfig,
            detailFeedback
          });
        } else {
          event.is_duplicate = false;
          event.duplicate_match_url = null;
          event.duplicate_reason = null;
          event.community_hub_payload = event.community_hub_payload || {};
          event.community_hub_payload.is_duplicate = false;
          event.community_hub_payload.duplicate_match_url = null;
        }

        const candidateUpsert = repository.upsertCandidate(source.id, candidate);
        repository.upsertStagingEvent(source.id, candidateUpsert?.record?.id || null, event);

        await sleep(runtimeConfig.detailExtractionDelayMs ?? 1500);
      }

      logActivity({ type: "watch_done", source: source.source_name, new_found: newCandidates.length, extracted });
      return { status: "new_events_extracted", new_count: newCandidates.length, extracted };

    } catch (err) {
      logActivity({ type: "watch_error", source: source.source_name, error: err.message });
      console.error("watch: unexpected error for", sourceId, err.message);
      return { status: "error", error: err.message };
    } finally {
      runningSources.delete(sourceId);
    }
  }

  /**
   * Watch all active sources — runs processSourceIncremental for each.
   * Called by the watcher scheduler (shorter cadence than the full extraction poll).
   */
  async function watchAllSources() {
    await syncHubIfStale();
    const sources = repository.listSources().filter(s => s.is_active);
    const results = [];
    for (const source of sources) {
      try {
        results.push({ source_id: source.id, ...(await processSourceIncremental(source.id)) });
      } catch (err) {
        results.push({ source_id: source.id, status: "error", error: err.message });
      }
    }
    return results;
  }

  async function processDueSources() {
    // Refresh the hub snapshot first so dedupe memory is always current
    await syncHubIfStale();

    const dueSources = repository.getDueSources(3);
    const results = [];
    for (const source of dueSources) {
      try {
        results.push(await processSource(source.id));
      } catch (error) {
        results.push({
          status: "failed",
          source_id: source.id,
          error: error.message
        });
      }
    }
    return results;
  }

  function startScheduler() {
    if (!runtimeConfig.pollerEnabled) {
      return () => {};
    }

    // Full extraction poll (default ~1h) — runs detail+hyperlocal+dedup for due sources
    const fullInterval = setInterval(() => {
      processDueSources().catch((error) => {
        console.error("automation scheduler error", error);
      });
    }, runtimeConfig.pollerIntervalMs);

    // Change watcher (default 30 min) — only triggers pipeline for genuinely new URLs
    const watchIntervalMs = Number(process.env.WATCHER_INTERVAL_MS || 30 * 60 * 1000);
    const watchInterval = setInterval(() => {
      watchAllSources().catch((error) => {
        console.error("watcher scheduler error", error);
      });
    }, watchIntervalMs);

    processDueSources().catch((error) => {
      console.error("initial automation poll error", error);
    });

    return () => {
      clearInterval(fullInterval);
      clearInterval(watchInterval);
    };
  }

  return {
    seedIfEnabled,
    processSource,
    processSourceIncremental,
    watchAllSources,
    processDueSources,
    startScheduler
  };
}
