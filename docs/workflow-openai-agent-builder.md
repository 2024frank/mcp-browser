# End-to-end workflow & OpenAI Agent Builder

This matches the intended operator flow: **sources → listing agent → detail agent → dedupe (Community Hub aware) → optional hyperlocal → review**.

Public Community Hub calendar (for humans): [Community Events Calendar](https://environmentaldashboard.org/calendar/?show-menu-bar=1).

## How this maps to code in this repo

| Your “agent” | Role | Agent Builder / OpenAI | This repo |
|----------------|------|---------------------------|-----------|
| **Listing** | From each source, collect event links + title hints | Workflow with **browser MCP** → `MCP_BROWSER_URL` | `openai_listing_v1` → `adapters/agentListing.js` |
| **Detail → dashboard** | For each link, open page, fill **Community Hub–shaped** fields | Workflow with **browser MCP** | `adapters/agentDetail.js` (chained after listing in `service.js`) |
| **Dedupe** | Cross-source + vs **known Community Hub** events | Workflow **without** MCP (JSON only), or use our server hook | SQL `findDuplicateMatch` + optional `agents/agentDedupe.js` |
| **Hyperlocal** | Tag / filter “Oberlin-area” vs broader | Separate small workflow **without** MCP | Stub / future `agents/agentHyperlocal.js` (see below) |

You can **prototype everything in [OpenAI Agent Builder](https://platform.openai.com)** (same prompts/tools), then keep this service as the **scheduler + database + API** so runs are unattended on Render.

## “Memory” across Source A and Source B

There is no separate in-RAM graph. **Memory is the database:**

- **`event_candidates`** / **`events_staging`** — everything extracted from any source.
- **`community_hub_events`** — your **mirror** of what already exists on the Community Hub (used for dedupe).

When Source B extracts an event that is the same real-world occurrence as Source A, **dedupe** compares against **all staging rows (other sources)** and **hub rows**, not “only this source.” That gives you cross-source skip without the agents holding state between calls.

## Staying “abreast” of the live Community Hub

The public calendar page does **not** expose a push webhook to your automation service. Practical options:

1. **Periodic sync job** (recommended): on a schedule, **import** known published events into `community_hub_events` via `POST /api/community-hub-events` (title, `start_datetime`, `source_event_url`, `community_hub_url`, etc.).  
2. **Manual / admin import** after major publishes.  
3. **Future**: if the dashboard exposes an API or RSS/ICS export of *published* events, call that from the same job.

Until the hub feed is wired, dedupe is only as good as **how full** `community_hub_events` is.

## Suggested Agent Builder layout

Build **three published workflows** (or one parent workflow with three steps):

1. **Listing collector**  
   - Tools: remote MCP (`https://<your-mcp>.onrender.com/mcp`).  
   - Output JSON: `{ "event_links": [...], "next_page_url": "" }`.

2. **Event detail (dashboard)**  
   - Tools: same MCP.  
   - Output JSON: keys aligned with `schemas/community_hub_submission.schema.json` / `community_hub_payload`.

3. **Duplicate judge** (optional duplicate of server logic)  
   - Tools: **none**.  
   - Input: incoming event JSON + list of existing hub/staging snippets.  
   - Output: `{ "is_duplicate": bool, "duplicate_match_url": string | null, "confidence": number }`.

**Hyperlocal** (fourth):  
   - Tools: none.  
   - Input: one staged event + policy text (“Oberlin city limits”, campus, etc.).  
   - Output: `{ "hyperlocal_tags": [], "passes_hyperlocal_gate": bool }`.

Export or copy SDK code when stable; the Render service can call the same patterns embedded in `adapters/*.js`.

## Resilience (100 + 100 links without one crash killing the run)

- Listing returns **many** links; detail extraction runs **one URL at a time** with **`max_detail_extractions`** and **`DETAIL_EXTRACTION_DELAY_MS`**.  
- Failures on a single URL are **logged**; other URLs continue (`service.js` try/catch per candidate).  
- Run smaller batches by lowering `max_links` / `max_detail_extractions` first, then scale up.

## What we need from you to go live

| Item | Purpose |
|------|---------|
| `OPENAI_API_KEY` | Listing + detail + dedupe agents on the automation service |
| `MCP_BROWSER_URL` | Public URL of Playwright MCP (`…/mcp`) |
| **Community Hub snapshot** | Regular `POST` rows to `/api/community-hub-events` so dedupe matches [the live calendar](https://environmentaldashboard.org/calendar/?show-menu-bar=1) |
| **Hyperlocal policy** | Short written rules (geography, campus vs town) for the fourth agent when implemented |

## Tests

Run locally:

```bash
node scripts/test-automation-smoke.mjs
```

This checks imports and HTTP `/health` only. Full listing/detail tests **call OpenAI** and cost money; run those in Agent Builder Preview or against staging with small `max_links`.
