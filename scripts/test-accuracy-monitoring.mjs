#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRepository } from "../src/automation/db.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oberlin-accuracy-"));
const dbPath = path.join(tmpDir, "accuracy.db");

const repository = createRepository({
  dataDir: tmpDir,
  dbPath
});

repository.createSource({
  source_id: "src_test",
  source_name: "Test Source",
  source_type: "browser",
  adapter_key: "openai_listing_v1",
  listing_url: "https://example.com/events"
});

repository.upsertStagingEvent("src_test", null, {
  title: "Original AI Title",
  organizational_sponsor: "AI Sponsor",
  start_datetime: "2026-04-20T18:00:00-04:00",
  end_datetime: "2026-04-20T19:00:00-04:00",
  location_type: "In-Person",
  location_or_address: "50 Main St, Oberlin, OH",
  room_number: null,
  event_link: null,
  short_description: "AI short description",
  extended_description: "AI extended description",
  artwork_url: null,
  source_name: "Test Source",
  source_domain: "example.com",
  source_listing_url: "https://example.com/events",
  source_event_url: "https://example.com/events/original-ai-title",
  is_duplicate: true,
  duplicate_match_url: "https://example.com/dup",
  duplicate_reason: "llm_duplicate_compare:test",
  review_status: "pending",
  community_hub_payload: {
    title: "Original AI Title",
    organizational_sponsor: "AI Sponsor",
    start_datetime: "2026-04-20T18:00:00-04:00",
    end_datetime: "2026-04-20T19:00:00-04:00",
    location_type: "In-Person",
    location_or_address: "50 Main St, Oberlin, OH",
    room_number: null,
    event_link: null,
    short_description_for_digital_signs: "AI short description",
    extended_description_for_web_and_newsletter: "AI extended description",
    artwork_upload_or_gallery: null,
    source_name: "Test Source",
    source_event_url: "https://example.com/events/original-ai-title",
    is_duplicate: true,
    duplicate_match_url: "https://example.com/dup"
  }
});

const [staged] = repository.listStaging({ sourceId: "src_test", limit: 5 });
assert(staged, "expected a staged event");
assert(staged.ai_baseline_payload === null, "baseline should be empty before review");

const reviewed = repository.reviewStagingEvent(
  staged.id,
  {
    title: "Human Corrected Title",
    short_description: "Human corrected short description",
    is_duplicate: false,
    duplicate_match_url: null,
    duplicate_reason: null,
    review_status: "approved"
  },
  {
    reviewer_name: "FK",
    review_note: "Corrected title and rescued duplicate false positive"
  }
);

assert(reviewed, "expected reviewed event");
assert(reviewed.title === "Human Corrected Title", "title should update after review");
assert(reviewed.review_status === "approved", "review status should update");
assert(reviewed.is_duplicate === false, "duplicate flag should be cleared");
assert(reviewed.ai_baseline_payload?.title === "Original AI Title", "baseline should preserve original AI title");
assert(
  reviewed.community_hub_payload?.title === "Human Corrected Title",
  "community_hub_payload should stay in sync with reviewed fields"
);

const metrics = repository.getAgentMetrics();
assert(metrics.accuracy.total_reviewed === 1, "one reviewed event should be counted");
assert(metrics.accuracy.comparable_reviewed === 1, "reviewed event should have a comparable baseline");
assert(metrics.accuracy.reviewed_with_corrections === 1, "corrected event should be counted");
assert(metrics.accuracy.duplicate_overrides === 1, "duplicate override should be counted");

const titleField = metrics.accuracy.field_accuracy.find((row) => row.field === "title");
assert(titleField?.changed_count === 1, "title should register as changed");

console.log("Accuracy monitoring test passed.");
