#!/usr/bin/env node
/**
 * Print getResearchSnapshot() + config flags to stdout (no HTTP server required).
 * Usage: node scripts/print-research-snapshot.mjs
 */
import { config } from "../src/automation/config.js";
import { createRepository } from "../src/automation/db.js";

const repository = createRepository(config);
const snap = repository.getResearchSnapshot();
console.log(
  JSON.stringify(
    {
      ...snap,
      config_flags: {
        skip_past_events: config.skipPastEventsForPipeline,
        past_event_grace_hours: config.pastEventGraceHours,
        openai_dedupe_enabled: config.openaiDedupeEnabled,
        research_experiment_id: config.researchExperimentId,
        hub_snapshot_url: config.communityHubCalendarUrl
      }
    },
    null,
    2
  )
);
