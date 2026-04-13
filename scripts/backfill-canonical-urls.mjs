#!/usr/bin/env node
/**
 * Normalize source_event_url (and hub community_hub_url) in the local DB for dedupe alignment.
 *
 * Usage:
 *   node scripts/backfill-canonical-urls.mjs --dry-run # preview counts only
 *   node scripts/backfill-canonical-urls.mjs              # apply (hub + staging)
 *   node scripts/backfill-canonical-urls.mjs --hub-only  # community_hub_events only
 */
import { config } from "../src/automation/config.js";
import { createRepository } from "../src/automation/db.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const hubOnly = argv.includes("--hub-only");

const repository = createRepository(config);
const result = repository.backfillCanonicalUrls({
  dryRun,
  includeStaging: !hubOnly
});

console.log(JSON.stringify(result, null, 2));
if (dryRun) {
  console.log("\nDry run — no writes. Re-run without --dry-run to apply.");
} else {
  console.log("\nBackfill complete.");
}
