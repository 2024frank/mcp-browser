# Cost controls (pilot / production)

The pipeline can spend **OpenAI tokens** on listing, detail extraction, hyperlocal tagging, **LLM dedupe**, hub page snapshots (MCP + model), and optional repair passes.

## Quick levers

| Goal | Setting |
|------|---------|
| **Cheapest deterministic dedupe** | `OPENAI_DEDUPE_ENABLED=false` — URL/title/fuzzy rules in SQLite still run; no duplicate-compare LLM. |
| **Fewer hub snapshots** | Raise `HUB_SYNC_INTERVAL_MS` (e.g. `14400000` = 4 hours). Each sync uses MCP + a model on the public calendar page. |
| **Slower / cheaper listing–detail** | Lower `max_links` and `max_detail_extractions` per source in `adapter_config`. Increase `DETAIL_EXTRACTION_DELAY_MS` to reduce burst rate. |
| **Smaller hub mirror extract** | Lower `COMMUNITY_HUB_SNAPSHOT_MAX_EVENTS` (e.g. `80`). |

## After changing dedupe defaults

If you previously relied on LLM dedupe and turn it off, expect **more false negatives** (duplicates reach review). Compensate with **more frequent Sync Hub** or stricter human duplicate tab triage.

## Canonical URL backfill

After enabling URL normalization, run once on each environment (or after restoring an old DB dump):

```bash
npm run backfill:canonical -- --dry-run
npm run backfill:canonical
```

Optional: hub mirror only:

```bash
node scripts/backfill-canonical-urls.mjs --hub-only
```

## Optional HTTP trigger (locked by default)

Set `ALLOW_MAINTENANCE_BACKFILL=true` on the server, then:

```bash
curl -X POST https://your-host/api/maintenance/backfill-canonical-urls \
  -H "Content-Type: application/json" \
  -d '{"dry_run":true}'
```

Remove the env var when finished.
