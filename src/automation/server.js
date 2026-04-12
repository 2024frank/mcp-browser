import { join } from "node:path";

import express from "express";

import { config } from "./config.js";
import { createRepository } from "./db.js";
import { syncCommunityHubCalendarFromBrowser } from "./adapters/agentHubSnapshot.js";
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
      community_hub_events_sync_browser: "POST /api/community-hub-events/sync-browser"
    }
  });
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    now: nowIso(),
    counts: repository.getSummaryCounts()
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
    const result = await automationService.processSource(request.params.id);
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error.message
    });
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

  // Field-edit mode — body contains editable content fields
  const editableFields = ["title","organizational_sponsor","start_datetime","end_datetime",
    "location_type","location_or_address","room_number","event_link",
    "short_description","extended_description","artwork_url"];
  const hasFields = editableFields.some(k => k in body);

  if (hasFields) {
    const updated = repository.patchStagingFields(request.params.id, body);
    if (!updated) {
      response.status(404).json({ error: "Staging event not found" });
      return;
    }
    response.json({ event: updated });
    return;
  }

  // Review-status mode
  const { review_status } = body;
  const valid = ["pending", "approved", "rejected"];
  if (!valid.includes(review_status)) {
    response.status(400).json({ error: `review_status must be one of: ${valid.join(", ")}` });
    return;
  }
  const updated = repository.updateStagingReviewStatus(request.params.id, review_status);
  if (!updated) {
    response.status(404).json({ error: "Staging event not found" });
    return;
  }
  response.json({ event: updated });
});

app.get("/api/agent-activity", (_request, response) => {
  response.json({ activity: [...agentActivityLog].reverse() });
});

app.get("/api/community-hub-events", (request, response) => {
  response.json({
    community_hub_events: repository.listHubEvents(Number(request.query.limit || 100))
  });
});

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

app.post("/api/community-hub-events/sync-browser", async (request, response) => {
  try {
    const body = request.body || {};
    const calendarUrl = body.calendar_url || config.communityHubCalendarUrl;
    const result = await syncCommunityHubCalendarFromBrowser(repository, {
      ...config,
      communityHubCalendarUrl: calendarUrl
    });
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error.message
    });
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
