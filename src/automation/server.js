import fs from "node:fs";
import { join } from "node:path";

import express from "express";

import { config } from "./config.js";
import { createRepository } from "./db.js";
import { syncCommunityHubCalendarFromBrowser } from "./adapters/agentHubSnapshot.js";
import { syncCommunityHubFromLegacyApi } from "./adapters/communityHubLegacyApi.js";
import { runPosterExtractionAgent } from "./agents/agentPoster.js";
import { createAutomationService, agentActivityLog } from "./service.js";
import { makeId, nowIso } from "./utils.js";

const repository = createRepository(config);
const automationService = createAutomationService(repository, config);
const seededCount = automationService.seedIfEnabled();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(process.cwd(), "public")));

app.get("/", (_request, response) => {
  response.json({
    service: "oberlin-calendar-automation",
    now: nowIso(),
    seeded_sources: seededCount,
    counts: repository.getSummaryCounts(),
    endpoints: {
      health: "/health",
      sources: "/api/sources",
      source_runs: "/api/source-runs",
      event_candidates: "/api/event-candidates",
      events_staging: "/api/events-staging",
      community_hub_events: "/api/community-hub-events",
      community_hub_events_sync_legacy_api: "POST /api/community-hub-events/sync-legacy-api",
      community_hub_events_sync_browser: "POST /api/community-hub-events/sync-browser",
      research_snapshot: "/api/research/snapshot",
      maintenance_reset:
        "POST /api/maintenance/reset (requires ALLOW_MAINTENANCE_RESET=true + body {confirm:'RESET'})",
      maintenance_backfill_canonical:
        "POST /api/maintenance/backfill-canonical-urls (requires ALLOW_MAINTENANCE_BACKFILL=true)"
    }
  });
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    now: nowIso(),
    counts: repository.getSummaryCounts(),
    env: {
      openai_api_key: !!process.env.OPENAI_API_KEY?.trim(),
      mcp_browser_url: !!(process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim()
    }
  });
});

app.get("/api/sources", (_request, response) => {
  response.json({ sources: repository.listSources() });
});

app.post("/api/sources", (request, response) => {
  const body = request.body || {};
  if (!body.source_name || !body.source_type) {
    response.status(400).json({
      error: "source_name and source_type are required"
    });
    return;
  }

  const created = repository.createSource(body);
  response.status(201).json({ source: created });
});

app.patch("/api/sources/:id", (request, response) => {
  const updated = repository.updateSource(request.params.id, request.body || {});
  if (!updated) {
    response.status(404).json({ error: "Source not found" });
    return;
  }

  response.json({ source: updated });
});

app.post("/api/sources/:id/run", async (request, response) => {
  try {
    const patch = request.body?.adapter_config;
    const result = await automationService.processSource(request.params.id, {
      adapter_config: patch && typeof patch === "object" ? patch : undefined
    });
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error.message
    });
  }
});

/**
 * POST /api/sources/:id/watch
 * Incremental watch for one source — listing check + pipeline only for new URLs.
 */
app.post("/api/sources/:id/watch", async (request, response) => {
  try {
    const result = await automationService.processSourceIncremental(request.params.id);
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/watch
 * Trigger an incremental watch across all active sources.
 */
app.post("/api/watch", async (_request, response) => {
  try {
    const results = await automationService.watchAllSources();
    response.json({ results });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/runs/discover-due-sources", async (_request, response) => {
  const results = await automationService.processDueSources();
  response.json({ results });
});

app.get("/api/source-runs", (request, response) => {
  response.json({
    runs: repository.listRuns({
      sourceId: request.query.sourceId || null,
      limit: Number(request.query.limit || 50)
    })
  });
});

app.get("/api/event-candidates", (request, response) => {
  response.json({
    event_candidates: repository.listCandidates({
      sourceId: request.query.sourceId || null,
      limit: Number(request.query.limit || 100)
    })
  });
});

app.get("/api/events-staging", (request, response) => {
  response.json({
    events_staging: repository.listStaging({
      sourceId: request.query.sourceId || null,
      limit: Number(request.query.limit || 100)
    })
  });
});

app.patch("/api/events-staging/:id", (request, response) => {
  const body = request.body || {};

  const editableFields = [
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
    "is_duplicate",
    "duplicate_match_url",
    "duplicate_reason"
  ];
  const hasEditableFields = editableFields.some((key) => key in body);
  const hasReviewStatus = "review_status" in body;

  if (!hasEditableFields && !hasReviewStatus) {
    response.status(400).json({
      error: "Provide editable fields and/or review_status"
    });
    return;
  }

  if (hasReviewStatus) {
    const valid = ["pending", "approved", "rejected"];
    if (!valid.includes(body.review_status)) {
      response.status(400).json({ error: `review_status must be one of: ${valid.join(", ")}` });
      return;
    }
    if (body.review_status === "rejected") {
      if (!String(body.rejection_reason || "").trim()) {
        response.status(400).json({ error: "rejection_reason is required when rejecting an event" });
        return;
      }
      const validAgents = ["detail_extractor", "dedupe_agent", "hyperlocal_agent", "listing_agent", "other"];
      if (!validAgents.includes(body.fault_agent)) {
        response.status(400).json({
          error: `fault_agent must be one of: ${validAgents.join(", ")}`
        });
        return;
      }
    }
  }

  const updated = repository.reviewStagingEvent(
    request.params.id,
    body,
    {
      reviewer_name: body.reviewer_name || null,
      review_note: body.review_note || null
    }
  );
  if (!updated) {
    response.status(404).json({ error: "Staging event not found" });
    return;
  }
  if (body.review_status === "rejected") {
    repository.addAgentFeedback({
      staging_event_id: updated.id,
      source_id: updated.source_id || null,
      fault_agent: body.fault_agent,
      rejection_reason: String(body.rejection_reason).trim(),
      reviewer_name: body.reviewer_name || null
    });
  }
  response.json({ event: updated });
});

app.get("/api/agent-activity", (_request, response) => {
  response.json({ activity: [...agentActivityLog].reverse() });
});

/** Local mirror of published calendar rows (SQLite) — not an upstream Environmental Dashboard API. */
app.get("/api/community-hub-events", (request, response) => {
  response.json({
    community_hub_events: repository.listHubEvents(Number(request.query.limit || 100))
  });
});

/** Insert/update one mirrored hub row (manual seed or tooling) — still not calling a Hub API. */
app.post("/api/community-hub-events", (request, response) => {
  const body = request.body || {};
  if (!body.title && !body.source_event_url) {
    response.status(400).json({
      error: "title or source_event_url is required"
    });
    return;
  }

  const record = repository.addCommunityHubEvent(body);
  response.status(201).json({ community_hub_event: record });
});

/**
 * POST /api/poster-extract
 * Research feature (AI Micro Grant): extract event info from a poster image.
 * Body: { image_url: "https://..." }  OR  { image_base64: "...", media_type: "image/jpeg" }
 * Optional: { source_name: "My Event Poster", save: true }
 *
 * Returns the extracted community_hub_payload.
 * When save=true the event is also upserted into events_staging for review.
 */
app.post("/api/poster-extract", async (request, response) => {
  const body = request.body || {};
  const { image_url, image_base64, media_type, source_name, save } = body;

  if (!image_url && !image_base64) {
    response.status(400).json({ error: "Provide image_url or image_base64" });
    return;
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    response.status(503).json({ error: "OPENAI_API_KEY not configured on this service" });
    return;
  }

  try {
    const imageInput = image_url
      ? { url: image_url }
      : { base64: image_base64, mediaType: media_type || "image/jpeg" };

    const result = await runPosterExtractionAgent(imageInput, {
      sourceName: source_name || "Poster Upload"
    });

    let stagingRecord = null;
    if (save) {
      // Ensure a "poster-upload" pseudo-source exists
      const pseudoSourceId = "poster-upload";
      if (!repository.getSource(pseudoSourceId)) {
        repository.createSource({
          source_id: pseudoSourceId,
          source_name: source_name || "Poster Upload",
          source_type: "browser",
          adapter_key: "openai_listing_v1",
          is_active: false,
          notes: "Auto-created for poster extraction results."
        });
      }
      // Use a unique URL so each poster gets its own row
      const posterUrl = image_url || `poster:${makeId("img")}`;
      result.staging_event.source_event_url = result.staging_event.source_event_url || posterUrl;
      const upsert = repository.upsertStagingEvent(pseudoSourceId, null, result.staging_event);
      stagingRecord = upsert.record;
    }

    response.json({
      community_hub_payload: result.community_hub_payload,
      staging_event: result.staging_event,
      saved: !!save,
      staging_record: stagingRecord,
      model: result.model
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/sources/apply-seed
 * Force-sync sources from sources.example.json into the DB — updates existing rows,
 * inserts new ones. Use this after editing the seed file to propagate changes.
 */
app.post("/api/sources/apply-seed", (_request, response) => {
  try {
    const raw = fs.readFileSync(config.seedSourcesPath, "utf8");
    const seedSources = JSON.parse(raw);
    const result = repository.applySeedSources(seedSources);
    response.json({ ok: true, ...result, total: seedSources.length });
  } catch (err) {
    response.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/metrics
 * Per-agent pipeline metrics: candidates, staging, scope distribution, dedup & approval rates.
 */
app.get("/api/metrics", (_request, response) => {
  response.json(repository.getAgentMetrics());
});

app.get("/api/metrics/history", (_request, response) => {
  const metrics = repository.getAgentMetrics();
  response.json({
    history: metrics.history || { days: 0, by_day: [] },
    failures: metrics.failures || { groups: [] }
  });
});

/**
 * GET /api/research/snapshot
 * Frozen-friendly counts for pilot papers: QA distribution, scope, feedback volume,
 * past-event auto-filter, pending human queue. No secrets.
 */
app.get("/api/research/snapshot", (_request, response) => {
  const snap = repository.getResearchSnapshot();
  response.json({
    ...snap,
    config_flags: {
      skip_past_events: config.skipPastEventsForPipeline,
      past_event_grace_hours: config.pastEventGraceHours,
      openai_dedupe_enabled: config.openaiDedupeEnabled,
      research_experiment_id: config.researchExperimentId,
      hub_snapshot_url: config.communityHubCalendarUrl
    }
  });
});

/**
 * POST /api/maintenance/reset
 * Wipes all event data (candidates, staging, hub events, runs, feedback) and
 * re-seeds sources from sources.example.json so the pipeline restarts clean.
 * Requires ALLOW_MAINTENANCE_RESET=true (set temporarily on Render, unset after).
 * Body: { "confirm": "RESET" }  (must pass exact string to prevent accidents)
 */
app.post("/api/maintenance/reset", (request, response) => {
  if (process.env.ALLOW_MAINTENANCE_RESET !== "true") {
    response.status(403).json({
      error: "Disabled. Set ALLOW_MAINTENANCE_RESET=true temporarily, then unset after."
    });
    return;
  }
  const body = request.body || {};
  if (body.confirm !== "RESET") {
    response.status(400).json({ error: 'Send { "confirm": "RESET" } to confirm.' });
    return;
  }
  try {
    const result = repository.resetEventData();
    // Re-seed sources from the seed file
    let seeded = 0;
    try {
      const raw = fs.readFileSync(config.seedSourcesPath, "utf8");
      const seedSources = JSON.parse(raw);
      const applied = repository.applySeedSources(seedSources);
      seeded = applied.inserted + applied.updated;
    } catch (seedErr) {
      console.warn("reset: seed re-apply failed:", seedErr.message);
    }
    response.json({ ...result, sources_reseeded: seeded });
  } catch (err) {
    response.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/maintenance/backfill-canonical-urls
 * Body: { "dry_run": true, "staging": true } — staging defaults true; set staging:false for hub-only.
 * Requires ALLOW_MAINTENANCE_BACKFILL=true (avoid accidental public calls on Render).
 */
app.post("/api/maintenance/backfill-canonical-urls", (request, response) => {
  if (process.env.ALLOW_MAINTENANCE_BACKFILL !== "true") {
    response.status(403).json({
      error: "Disabled. Set ALLOW_MAINTENANCE_BACKFILL=true temporarily, then unset after running."
    });
    return;
  }
  const body = request.body || {};
  const result = repository.backfillCanonicalUrls({
    dryRun: body.dry_run === true,
    includeStaging: body.staging !== false
  });
  response.json(result);
});

/** Pull approved future posts from Community Hub legacy JSON (no OpenAI/MCP). */
app.post("/api/community-hub-events/sync-legacy-api", async (request, response) => {
  try {
    const body = request.body || {};
    const result = await syncCommunityHubFromLegacyApi(repository, {
      ...config,
      communityHubLegacyPostsUrl:
        body.posts_url || body.legacy_posts_url || config.communityHubLegacyPostsUrl,
      communityHubPublicPostBase:
        body.public_post_base || config.communityHubPublicPostBase
    });
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/community-hub-events/sync-browser", async (request, response) => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    response.status(503).json({
      error: "OPENAI_API_KEY is not set on this service. Add it in the Render dashboard → Environment → OPENAI_API_KEY."
    });
    return;
  }
  if (!(process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim()) {
    response.status(503).json({
      error: "MCP_BROWSER_URL is not set on this service. Add it in the Render dashboard → Environment → MCP_BROWSER_URL."
    });
    return;
  }
  try {
    const body = request.body || {};
    const calendarUrl = body.calendar_url || config.communityHubCalendarUrl;
    const result = await syncCommunityHubCalendarFromBrowser(repository, {
      ...config,
      communityHubCalendarUrl: calendarUrl
    });
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

const stopScheduler = automationService.startScheduler();

const server = app.listen(config.port, () => {
  console.log(`Oberlin calendar automation listening on port ${config.port}`);
});

function shutdown() {
  stopScheduler();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
