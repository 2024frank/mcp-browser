# Pilot research methodology — AI agents for a unified Oberlin calendar

This document supports the **AI Micro-Grant** objective: test **feasibility**, **accuracy**, and **usefulness** of multi-agent pipelines that aggregate **distributed public event listings** into a **single, vettable feed** aligned with the [Environmental Dashboard community calendar](https://environmentaldashboard.org/calendar).

## Research questions

1. **Feasibility** — Can agents reliably discover new URLs, extract form-complete records, and run on a sustainable schedule (API cost, MCP availability)?
2. **Accuracy** — How often do extracted fields match what a human needs after **minimal correction**? Which fields and sources fail most?
3. **Usefulness** — Does the system **reduce duplicate work** (hub overlap, cross-posted events) and **surface only actionable items** for reviewers?

## System boundaries (what we measure)

- **In scope:** Public pages and feeds configured as `sources`; staging rows in `events_staging`; mirror of published hub in `community_hub_events` for dedupe context.
- **Out of scope:** Non-public or access-restricted calendars; automated publication to the hub without human approval (pilot keeps a human gate).

## Definitions

| Term | Meaning |
|------|---------|
| **Candidate** | A discovered event URL + fingerprint in `event_candidates`. |
| **Staging event** | A structured record ready for review (`events_staging`). |
| **Human pending queue** | `review_status = pending`, not duplicate, not auto-filtered as past (see below). |
| **AI baseline** | Snapshot of AI output before human edit; used for correction-rate metrics. |
| **QA status** | `extraction_metadata.qa_status` from programmatic quality gate (+ repair loop). |

Operational cost levers and one-off URL backfill: [`docs/COST_CONTROLS.md`](COST_CONTROLS.md).

## Dedupe vs hub mirror

Incoming events are matched against `community_hub_events` using **normalized URLs** (hostname lowercased, trivial trailing slash removed), **exact title + start_datetime** (trimmed title), and **fuzzy title + start + location** against hub rows. **LLM dedupe** is **on by default** (disable with `OPENAI_DEDUPE_ENABLED=false`). Hub snapshot refresh defaults to **every 1 hour** (`HUB_SYNC_INTERVAL_MS`).

## Instrumentation (built into the app)

- **`GET /api/metrics`** — Throughput, per-source staging, hyperlocal distribution, human correction rates, source health, learning feedback aggregates.
- **`GET /api/metrics/history`** — Daily trends (reviews, corrections, run failures).
- **`GET /api/research/snapshot`** — Compact JSON for papers or appendices: QA distribution, scope distribution, feedback row counts, **past-event auto-reject** counts, **pending human review** count (excludes duplicates and past-event rejects).
- **`npm run research:snapshot`** — Same payload from the CLI against the local DB (no server).
- **`npm run eval:pilot`** — Controlled run with temporary `max_links` / `max_detail_extractions`; optional JSONL log in `${DATA_DIR}/pilot-eval-log.jsonl`.
- **`RESEARCH_EXPERIMENT_ID`** — Stored in `source_runs.summary_json` on successful runs for cohort labeling.
- **`SKIP_PAST_EVENTS`** (default `true`) — Rejects staging rows whose `start_datetime` is before “now” (optional **`PAST_EVENT_GRACE_HOURS`**), skips hyperlocal/dedupe/QA to save cost; row retained for audit with `auto_reject_reason: event_start_in_past`.

## Recommended study protocol (8-week pilot sketch)

1. **Week 0** — Freeze `sources.example.json`; set `RESEARCH_EXPERIMENT_ID`; document env (models, `OPENAI_DEDUPE_ENABLED`, MCP URL).
2. **Weekly** — Run `npm run research:snapshot`; append screenshot or JSON to lab notes; run `eval:pilot` on one or two sources with small caps.
3. **Review sessions** — N reviewers × M events; record approve / reject + `fault_agent` + reason (feeds `agent_feedback`).
4. **Analysis** — Correction rate by field and source; QA pass vs reject; duplicate precision (sample manual audit on duplicate tab); cost per accepted event (from provider dashboards).

## Ethics (summary)

Only **public** event information intended for attendance; **source attribution** preserved; no credential scraping; human oversight before publication.

## Limitations (state explicitly in write-ups)

- There is **no public Community Hub “list all events” API** from Environmental Dashboard; the pilot uses a **browser snapshot of the public calendar page** into `community_hub_events`. That mirror is **model-mediated**, **partial**, and **not** equivalent to a full authoritative API dump.
- LLM dedupe is **conservative by design**; false negatives/positives require human override.
- **Past-event filter** uses extracted `start_datetime` quality; bad dates can miscategorize.

## Files

- Pipeline: `src/automation/service.js`
- Metrics & snapshot: `src/automation/db.js`, `src/automation/server.js`
- Controlled eval: `scripts/run-pilot-evaluation.mjs`, `scripts/print-research-snapshot.mjs`
