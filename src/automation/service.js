import fs from "node:fs";

import { syncCommunityHubCalendarFromBrowser } from "./adapters/agentHubSnapshot.js";
import { extractDashboardEventFromCandidate } from "./adapters/agentDetail.js";
import { runOpenAiListingAdapter } from "./adapters/agentListing.js";
import { runBrowserListingAdapter } from "./adapters/browser.js";
import { runIcsAdapter } from "./adapters/ics.js";
import { runLocalistAdapter } from "./adapters/localist.js";
import { buildDedupeContext, runDuplicateCompareAgent } from "./agents/agentDedupe.js";
import { runHyperlocalAgent } from "./agents/agentHyperlocal.js";
import { parseJson, sleep } from "./utils.js";

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

    try {
      const result = await adapter(source, runtimeConfig);

      const stagedEvents = [...(result.stagedEvents || [])];
      const baseStagedCount = stagedEvents.length;

      if (shouldExtractEventDetails(source, result)) {
        const maxDetail = Number(source.adapter_config?.max_detail_extractions ?? 25);
        let extracted = 0;
        for (const candidate of result.candidates || []) {
          if (extracted >= maxDetail) {
            break;
          }
          try {
            const evt = await extractDashboardEventFromCandidate(
              source,
              candidate,
              runtimeConfig
            );
            stagedEvents.push(evt);
            extracted += 1;
          } catch (err) {
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
        // --- Agent 4: Hyperlocal classifier (no browser — pure text, cheap) ---
        if (process.env.OPENAI_API_KEY?.trim()) {
          try {
            const geo = await runHyperlocalAgent(event, runtimeConfig);
            event.hyperlocal_scope = geo.scope;
            event.geographic_tags = geo.geographic_tags;
          } catch (err) {
            console.error("hyperlocal agent failed for", event.title, err.message);
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
          try {
            const ctx = buildDedupeContext(
              repository,
              source.id,
              runtimeConfig.openaiDedupeContextLimit
            );
            const llm = await runDuplicateCompareAgent(event, ctx, runtimeConfig);
            if (llm.applied && llm.is_duplicate) {
              duplicateMatch = {
                is_duplicate: true,
                duplicate_match_url: llm.duplicate_match_url,
                duplicate_reason: llm.duplicate_reason
              };
            }
          } catch (err) {
            console.error("duplicate compare agent failed", err.message);
          }
        }

        event.is_duplicate = duplicateMatch.is_duplicate;
        event.duplicate_match_url = duplicateMatch.duplicate_match_url;
        event.duplicate_reason = duplicateMatch.duplicate_reason;
        event.community_hub_payload.is_duplicate = event.is_duplicate;
        event.community_hub_payload.duplicate_match_url = event.duplicate_match_url;

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

    const interval = setInterval(() => {
      processDueSources().catch((error) => {
        console.error("automation scheduler error", error);
      });
    }, runtimeConfig.pollerIntervalMs);

    processDueSources().catch((error) => {
      console.error("initial automation poll error", error);
    });

    return () => clearInterval(interval);
  }

  return {
    seedIfEnabled,
    processSource,
    processDueSources,
    startScheduler
  };
}
