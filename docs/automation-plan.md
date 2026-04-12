# Automation Plan

## Objective

Build an event aggregation system where the normal operator workflow is:

1. Add a new source.
2. The system checks that source on a schedule.
3. New or changed events are discovered automatically.
4. Each event is normalized into Community Hub-compatible fields.
5. Duplicates are checked against staged and published calendar records.
6. Approved events are sent to the Community Hub vetting flow.

## Core Design

Use a source registry and a source adapter model.

Every source should have:

- a persistent source record
- an adapter type
- a polling schedule
- extraction rules

## Source Types

Not all sources should be handled the same way.

### 1. API Sources

Use direct API calls when a source provides structured event data.

Example:

- Oberlin College Localist API

Notes:

- The Localist API is read-only.
- Official docs recommend limiting usage to less than 1 request per second.
- The event API supports paging and date-range queries.
- Event details can include filters, custom fields, event instances, photo URL, and `localist_ics_url`.

Recommended use:

- poll `/api/2/events`
- store source event IDs and `updated_at` values when available
- use API data first, browser extraction only as fallback

### 2. ICS / Calendar Feed Sources

Use calendar subscriptions when a source exposes an ICS feed.

Recommended use:

- fetch the ICS on a schedule
- parse VEVENT entries
- generate stable candidate IDs using source + UID or URL

### 3. Browser / MCP Sources

Use the browser-based agent pipeline when the source does not have a reliable API or ICS feed.

Recommended use:

- listing collector agent discovers event URLs
- event detail extractor agent opens one event page at a time

## Source Registry

Store sources in a database table named `sources`.

Suggested fields:

```json
{
  "source_id": "uuid",
  "source_name": "Experience Oberlin",
  "source_domain": "experienceoberlin.com",
  "source_type": "browser",
  "listing_url": "https://experienceoberlin.com/events",
  "api_base_url": null,
  "ics_url": null,
  "adapter_key": "browser_listing_v1",
  "poll_interval_minutes": 360,
  "is_active": true,
  "attribution_label": "Experience Oberlin",
  "notes": "Public event listing page",
  "created_at": "timestamp",
  "updated_at": "timestamp"
}
```

## Event Processing Tables

### `event_candidates`

Discovered raw event references before full extraction.

```json
{
  "candidate_id": "uuid",
  "source_id": "uuid",
  "external_event_id": null,
  "event_url": "https://www.experienceoberlin.com/event/oberlin-farmers-market/",
  "title_hint": "Oberlin Farmers Market",
  "fingerprint": "hash",
  "discovered_at": "timestamp",
  "last_seen_at": "timestamp",
  "status": "new"
}
```

### `events_staging`

Normalized extracted records waiting for duplicate review or approval.

### `community_hub_events`

Published or already-approved records from the Community Hub side.

## Update Detection

Do not "listen" for updates in the webhook sense unless a source explicitly supports webhooks.

Use scheduled polling plus change detection:

1. poll the source
2. collect candidate events
3. compare with existing candidates by:
   - external ID
   - event URL
   - fingerprint
4. mark records as:
   - new
   - changed
   - unchanged
   - disappeared

## Polling Strategy

### API Sources

Use incremental fetches when possible.

For Oberlin Localist:

- poll `https://calendar.oberlin.edu/api/2/events`
- use `days`, `pp`, and `page`
- inspect `filters` and `custom_fields`
- use public-status filtering when that field becomes reliable

Suggested initial fetch:

`https://calendar.oberlin.edu/api/2/events?days=365&pp=100&page=1`

### Browser Sources

Poll less often and cache aggressively.

Suggested interval:

- every 6 to 12 hours for public listing pages

### ICS Sources

Poll on the same schedule as browser sources unless a source updates very frequently.

## Duplicate Checking

Do not compare a new event by re-browsing every source live.

Instead:

1. compare against `events_staging`
2. compare against `community_hub_events`
3. compare against source-native IDs and URLs

Use these levels:

1. exact `external_event_id`
2. exact `event_url`
3. exact `title + start_datetime + source`
4. fuzzy `title + date + location`

Store:

- `is_duplicate`
- `duplicate_match_id`
- `duplicate_match_url`
- `duplicate_reason`

## Community Hub Mapping

After extraction and dedupe, map each record into Community Hub fields:

- `title`
- `organizational_sponsor`
- `event_type_categories`
- `start_datetime`
- `end_datetime`
- `location_type`
- `location_or_address`
- `room_number`
- `event_link`
- `short_description_for_digital_signs`
- `extended_description_for_web_and_newsletter`
- `artwork_upload_or_gallery`
- `display_target`

## Operator Workflow

The intended human workflow should be:

1. create a source record
2. choose source type:
   - `api`
   - `ics`
   - `browser`
3. save credentials or URL if needed
4. test the source adapter
5. activate scheduled polling

After that, the system should run without manual prompting.

## Recommended Build Order

1. Source registry
2. API adapter for Oberlin Localist
3. Browser adapter for Experience Oberlin
4. Event detail extractor agent
5. Duplicate checker
6. Review queue
7. Community Hub mapper

## Oberlin Localist Integration

The Oberlin College calendar should be treated as a first-class API source, not as a browser source.

Reason:

- It has a documented API endpoint.
- It returns structured JSON.
- It is more stable than scraping.
- It can expose fields under `filters` and `custom_fields`.

The "public status" field referenced by Darby should be incorporated into source rules once the exact API field name is stable.

## File Search vs Database vs Vector Store

Use each tool for a different role:

- database: sources, candidates, extracted events, duplicate state, review state
- file search: taxonomies, source notes, mapping rules, reviewer guidance
- vector store: optional semantic lookup for source-specific extraction hints and duplicate heuristics

The database remains the system of record.
