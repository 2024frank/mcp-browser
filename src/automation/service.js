import fs from "node:fs";

import { syncCommunityHubCalendarFromBrowser } from "./adapters/agentHubSnapshot.js";
import { extractDashboardEventFromCandidate } from "./adapters/agentDetail.js";
import { runOpenAiListingAdapter } from "./adapters/agentListing.js";
import { runBrowserListingAdapter } from "./adapters/browser.js";
import { runIcsAdapter } from "./adapters/ics.js";
import { runLocalistAdapter } from "./adapters/localist.js";
import { buildDedupeContext, runDuplicateCompareAgent } from "./agents/agentDedupe.js";
import { runHyperlocalAgent } from "./agents/agentHyperlocal.js";
import { runQualityGateAgent } from "./agents/agentQualityGate.js";
import { runRepairAgent } from "./agents/agentRepair.js";
import { parseJson, nowIso, sleep } from "./utils.js";

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

const adapters = {
  browser_listing_v1: runBrowserListingAdapter,
  openai_listing_v1: runOpenAiListingAdapter,
  ics_v1: runIcsAdapter,
  localist_v1: runLocalistAdapter
};

// How often the hub snapshot is refreshed (default 4 h). Override via HUB_SYNC_INTERVAL_MS.
const HUB_SYNC_INTERVAL_MS = Number(process.env.HUB_SYNC_INTERVAL_MS || 4 * 60 * 60 * 1000);

export function createAutomationService(repository, runtimeConfig) {
  const runningSources = new Set();
  let hubLastSyncedAt = null; // in-process memory — resets on restart (intentional)

  /**
   * Refresh the community_hub_events table from the live calendar page.
   * Rate-limited: won't fire again until HUB_SYNC_INTERVAL_MS has elapsed.
   * Silently skips when OPENAI_API_KEY or MCP_BROWSER_URL is absent.
   */
  async function syncHubIfStale() {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const mcpUrl = (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
    if (!apiKey || !mcpUrl) {
      return false;
    }
    const now = Date.now();
    if (hubLastSyncedAt && now - hubLastSyncedAt < HUB_SYNC_INTERVAL_MS) {
      return false; // Still fresh
    }
    try {
      const result = await syncCommunityHubCalendarFromBrowser(repository, runtimeConfig);
      hubLastSyncedAt = Date.now();
      console.log(
        `hub sync complete — parsed ${result.parsed_count} events (inserted ${result.inserted}, updated ${result.updated})`
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

  async function processSource(sourceId) {
    if (runningSources.has(sourceId)) {
      return { status: "skipped", reason: "already_running" };
    }

    const source = repository.getSource(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }

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

        const qa = await runQualityGateAgent(event, runtimeConfig);
        if (!qa.passed) {
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
          const repair = await runRepairAgent(
            source,
            event,
            qa.issues,
            runtimeConfig,
            detailFeedback
          );
          if (repair.attempted && repair.repairedEvent) {
            mergeRepairIntoEvent(event, repair.repairedEvent);
            const qaAfterRepair = await runQualityGateAgent(event, runtimeConfig);
            if (!qaAfterRepair.passed) {
              event.review_status = "rejected";
              event.extraction_metadata = {
                ...(event.extraction_metadata || {}),
                qa_status: "rejected",
                qa_issues: qaAfterRepair.issues
              };
              logActivity({ type: "qa_reject", title: event.title, issues: qaAfterRepair.issues.length });
            } else {
              event.extraction_metadata = {
                ...(event.extraction_metadata || {}),
                qa_status: "repaired_pass"
              };
              logActivity({ type: "qa_repaired", title: event.title });
            }
          } else {
            event.review_status = "rejected";
            event.extraction_metadata = {
              ...(event.extraction_metadata || {}),
              qa_status: "rejected",
              qa_issues: qa.issues
            };
            logActivity({ type: "qa_reject", title: event.title, issues: qa.issues.length });
          }
        } else {
          event.extraction_metadata = {
            ...(event.extraction_metadata || {}),
            qa_status: "pass"
          };
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
          detail_extractions: detailExtractionsAdded
        }
      });
      repository.markSourceRunResult(source.id, "success", null, source.poll_interval_minutes);

      return {
        status: "success",
        source_id: source.id,
        new_candidates: newCandidates,
        upserted_events: upsertedEvents,
        summary: {
          ...(result.summary || {}),
          detail_extractions: detailExtractionsAdded
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

        const qa = await runQualityGateAgent(event, runtimeConfig);
        if (!qa.passed) {
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
          const repair = await runRepairAgent(
            source,
            event,
            qa.issues,
            runtimeConfig,
            detailFeedback
          );
          if (repair.attempted && repair.repairedEvent) {
            mergeRepairIntoEvent(event, repair.repairedEvent);
            const qaAfterRepair = await runQualityGateAgent(event, runtimeConfig);
            if (!qaAfterRepair.passed) {
              event.review_status = "rejected";
              event.extraction_metadata = {
                ...(event.extraction_metadata || {}),
                qa_status: "rejected",
                qa_issues: qaAfterRepair.issues
              };
              logActivity({ type: "qa_reject", title: event.title, issues: qaAfterRepair.issues.length });
            } else {
              event.extraction_metadata = {
                ...(event.extraction_metadata || {}),
                qa_status: "repaired_pass"
              };
              logActivity({ type: "qa_repaired", title: event.title });
            }
          } else {
            event.review_status = "rejected";
            event.extraction_metadata = {
              ...(event.extraction_metadata || {}),
              qa_status: "rejected",
              qa_issues: qa.issues
            };
            logActivity({ type: "qa_reject", title: event.title, issues: qa.issues.length });
          }
        } else {
          event.extraction_metadata = {
            ...(event.extraction_metadata || {}),
            qa_status: "pass"
          };
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
