# Oberlin Unified Calendar Project

## Goal

Build an AI-assisted pipeline that:

1. Collects public event links from multiple Oberlin-area sources.
2. Extracts structured event details from each source event page.
3. Checks for duplicates against already staged events and the Community Hub calendar.
4. Maps approved events into the Environmental Dashboard Community Hub submission format.
5. Sends final records to human review before publishing.

## Core Principle

Do not use one giant agent for the whole job.

Use a staged pipeline with small, testable agents:

1. Listing Collector Agent
2. Event Detail Extractor Agent
3. Duplicate Checker Agent
4. Normalizer / Tagger Agent
5. Review / Publish step

## Canonical Pipeline

1. Read active sources from the source registry.
2. For each source, collect event links from the listing page.
3. Save discovered links as event candidates.
4. For each event URL, extract one normalized event record.
5. Compare the normalized event against staged and published events.
6. Mark duplicates and confidence.
7. Map the normalized event into Community Hub fields.
8. Send the result to human review.
9. Publish approved events.

## Recommended Storage

Use a structured database for records and workflow state.

Suggested tables:

- `sources`
- `event_candidates`
- `events_staging`
- `community_hub_events`
- `review_queue`

Use file search or a vector store only for supporting knowledge, such as:

- source-specific extraction notes
- category definitions
- geographic tagging rules
- duplicate-matching guidance
- reviewer instructions

## Normalized Event Record

This is the internal event shape all sources should map into before Community Hub formatting:

```json
{
  "title": null,
  "organizational_sponsor": null,
  "event_type_categories": [],
  "start_datetime": null,
  "end_datetime": null,
  "location_type": null,
  "location_or_address": null,
  "room_number": null,
  "event_link": null,
  "short_description": null,
  "extended_description": null,
  "artwork_url": null,
  "source_name": null,
  "source_domain": null,
  "source_listing_url": null,
  "source_event_url": null,
  "is_duplicate": null,
  "duplicate_match_url": null,
  "duplicate_reason": null,
  "confidence": null,
  "review_status": "pending"
}
```

## Community Hub Form Mapping

These are the actual form sections observed on the Community Hub submission page:

### Top-level

- `post_type`
- `submitter_email`
- `newsletter_opt_in`
- `guidelines_acknowledged`

### 1. Contact Information

- `contact_email`
- `contact_phone`
- `organization_website`

### 2. Event Details

- `title`
- `organizational_sponsor`
- `event_type_categories`
- `start_datetime`
- `end_datetime`

### 3. Event Location

- `location_type`
- `location_or_address`
- `room_number`
- `event_link`

### 4. Event Description

- `short_description_for_digital_signs`
- `extended_description_for_web_and_newsletter`

### 5. Event Artwork

- `artwork_upload_or_gallery`

### 6. Event Display Preferences

- `display_target`

## Agent Builder Build Order

Build the system in this order:

1. Listing Collector Agent
2. Event Detail Extractor Agent
3. Duplicate Checker Agent
4. Normalizer / Tagger Agent
5. Review and publish workflow

## Phase 1 Success Criteria

Before moving on, the Listing Collector Agent should:

- open one listing page with browser tools
- return real event URLs
- ignore nav/header/footer links
- avoid returning the listing page itself
- return stable JSON for one source

## Later Production Architecture

When the pilot is stable, the ideal flow is:

1. Scheduler starts workflow.
2. Workflow reads active sources from database.
3. Workflow runs listing collection.
4. Workflow runs single-event extraction for each candidate URL.
5. Workflow deduplicates against staged and published records.
6. Workflow maps records into Community Hub fields.
7. Human reviews proposed events.
8. Approved events are published to the community calendar.
