/**
 * Integration test: Community Hub legacy posts JSON → SQLite mirror.
 * Uses a throwaway DB under os.tmpdir — no OpenAI/MCP.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRepository } from "../src/automation/db.js";
import { syncCommunityHubFromLegacyApi } from "../src/automation/adapters/communityHubLegacyApi.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-legacy-test-"));
const dbPath = path.join(tmpDir, "test.db");

const repository = createRepository({ dataDir: tmpDir, dbPath });

const result = await syncCommunityHubFromLegacyApi(repository, {
  communityHubLegacyPostsUrl:
    process.env.COMMUNITY_HUB_LEGACY_POSTS_URL ||
    "https://oberlin.communityhub.cloud/api/legacy/calendar/posts?approved=1&filter=future",
  communityHubPublicPostBase:
    process.env.COMMUNITY_HUB_PUBLIC_POST_BASE ||
    "https://environmentaldashboard.org/calendar/post",
  requestTimeoutMs: 45_000,
  communityHubLegacyPageSize: 100
});

const rows = repository.listHubEvents(500);

if (result.parsed_count < 1) {
  console.error("FAIL: expected at least one post from legacy API", result);
  process.exit(1);
}

if (rows.length !== result.parsed_count) {
  console.error("FAIL: listHubEvents length mismatch", {
    rows: rows.length,
    parsed: result.parsed_count
  });
  process.exit(1);
}

const sample = rows.find((r) => r.source_event_url?.includes("/calendar/post/"));
if (!sample?.title || !sample?.source_event_url) {
  console.error("FAIL: sample row missing title or URL", sample);
  process.exit(1);
}

if (!sample.short_description && !sample.extended_description) {
  console.warn("WARN: sample row has no descriptions (API may omit on some posts)");
}

console.log("OK — hub legacy API sync");
console.log(JSON.stringify({ ...result, sample_title: sample.title, sample_url: sample.source_event_url }, null, 2));

fs.rmSync(tmpDir, { recursive: true, force: true });
