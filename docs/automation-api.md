# Automation API

## Overview

The automation service exposes a small HTTP API for:

- adding sources
- listing sources
- triggering manual syncs
- inspecting candidates, staged events, and run history

**Community Hub:** The Environmental Dashboard calendar does not provide a public, documented “list all published events” REST API for this app to call. Endpoints under `/api/community-hub-events` work with a **local SQLite mirror** populated by either:

- legacy JSON sync (`COMMUNITY_HUB_LEGACY_POSTS_URL`, default path), or
- browser snapshot extraction (`/api/community-hub-events/sync-browser`, OpenAI + MCP required).

These are not proxies to an upstream Hub API.

## Health

```bash
curl http://localhost:10000/health
```

## List Sources

```bash
curl http://localhost:10000/api/sources
```

## Add a Source

### Localist API source

```bash
curl -X POST http://localhost:10000/api/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "source_name": "Oberlin College Localist",
    "source_domain": "calendar.oberlin.edu",
    "source_type": "api",
    "listing_url": "https://www.oberlin.edu/events",
    "api_base_url": "https://calendar.oberlin.edu/api/2",
    "adapter_key": "localist_v1",
    "poll_interval_minutes": 360,
    "is_active": true,
    "attribution_label": "Oberlin College Localist",
    "adapter_config": {
      "require_public": true,
      "days": 365,
      "per_page": 100,
      "max_pages": 5,
      "public_filter_key": "event_public_events",
      "allowed_public_labels": ["Open to all members of the public"]
    }
  }'
```

### ICS source

```bash
curl -X POST http://localhost:10000/api/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "source_name": "Example ICS Source",
    "source_domain": "example.com",
    "source_type": "ics",
    "listing_url": "https://example.com/calendar.ics",
    "ics_url": "https://example.com/calendar.ics",
    "poll_interval_minutes": 1440,
    "is_active": true,
    "attribution_label": "Example ICS"
  }'
```

### Browser source (OpenAI + remote Playwright MCP)

Requires `OPENAI_API_KEY` and `MCP_BROWSER_URL` on the automation service. See `docs/agents-integration.md`.

```bash
curl -X POST http://localhost:10000/api/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "source_name": "Experience Oberlin",
    "source_domain": "experienceoberlin.com",
    "source_type": "browser",
    "listing_url": "https://experienceoberlin.com/events",
    "adapter_key": "openai_listing_v1",
    "poll_interval_minutes": 720,
    "is_active": true,
    "attribution_label": "Experience Oberlin",
    "adapter_config": {
      "max_links": 25,
      "allowed_hosts": [
        "experienceoberlin.com",
        "www.experienceoberlin.com"
      ]
    }
  }'
```

Legacy: `browser_listing_v1` uses local Playwright + cheerio (no OpenAI). Prefer `openai_listing_v1` when the listing is dynamic or iframe-heavy.

## Update a Source

```bash
curl -X PATCH http://localhost:10000/api/sources/<source-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "is_active": false
  }'
```

## Run a Source Immediately

```bash
curl -X POST http://localhost:10000/api/sources/<source-id>/run
```

You can override adapter config for one run without changing stored source config:

```bash
curl -X POST http://localhost:10000/api/sources/<source-id>/run \
  -H 'Content-Type: application/json' \
  -d '{
    "adapter_config": { "max_links": 15, "max_detail_extractions": 10 }
  }'
```

## Run All Due Sources

```bash
curl -X POST http://localhost:10000/api/runs/discover-due-sources
```

## Watch endpoints (incremental new-link mode)

```bash
curl -X POST http://localhost:10000/api/watch
```

```bash
curl -X POST http://localhost:10000/api/sources/<source-id>/watch
```

## Inspect Outputs

### Source runs

```bash
curl 'http://localhost:10000/api/source-runs?sourceId=<source-id>&limit=10'
```

### Event candidates

```bash
curl 'http://localhost:10000/api/event-candidates?sourceId=<source-id>&limit=25'
```

### Staged events

```bash
curl 'http://localhost:10000/api/events-staging?sourceId=<source-id>&limit=25'
```

Each staged row includes **`community_hub_payload`**: field names align with the Environmental Dashboard submission form (see `schemas/community_hub_submission.schema.json`). Values may omit human-only fields (`submitter_email`, etc.); operators complete those in the UI.

## Community Hub Records

The service can store known Community Hub events for duplicate checking.

### List known Community Hub events

```bash
curl http://localhost:10000/api/community-hub-events
```

### Add a known Community Hub event

```bash
curl -X POST http://localhost:10000/api/community-hub-events \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Community Clean Up Day",
    "start_datetime": "2026-04-20T10:00:00-04:00",
    "end_datetime": "2026-04-20T13:00:00-04:00",
    "location_or_address": "Central Park",
    "source_event_url": "https://example.com/event/community-clean-up-day",
    "community_hub_url": "https://environmentaldashboard.org/calendar/event/community-clean-up-day"
  }'
```

### Force browser snapshot sync

```bash
curl -X POST http://localhost:10000/api/community-hub-events/sync-browser
```

### Force legacy API sync

```bash
curl -X POST http://localhost:10000/api/community-hub-events/sync-legacy-api
```

## Source seed and review endpoints

### Apply seed source config

```bash
curl -X POST http://localhost:10000/api/sources/apply-seed
```

### Update staged event review status

```bash
curl -X PATCH http://localhost:10000/api/events-staging/<event-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "review_status": "rejected",
    "rejection_reason": "Missing venue details",
    "fault_agent": "detail_extractor"
  }'
```

## Maintenance endpoints (guarded)

Enable these only for controlled operations:

- `ALLOW_MAINTENANCE_RESET=true`
- `ALLOW_MAINTENANCE_BACKFILL=true`

Reset event research data and re-seed sources:

```bash
curl -X POST http://localhost:10000/api/maintenance/reset \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"RESET"}'
```

Run canonical URL backfill:

```bash
curl -X POST http://localhost:10000/api/maintenance/backfill-canonical-urls \
  -H 'Content-Type: application/json' \
  -d '{"dry_run":true}'
```
