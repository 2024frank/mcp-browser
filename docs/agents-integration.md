# Agents + automation integration

## Split of responsibilities

| Layer | What runs | Where |
|--------|-----------|--------|
| **Playwright MCP** (`mcp-browser` service) | Browser only: navigate, snapshot, click, etc. | Render web service; URL ends with `/mcp` (or `/sse`). |
| **Automation** (`oberlin-calendar-automation`) | SQLite, schedules, Localist/ICS, dedupe hooks, HTTP API | Render web service + disk. |
| **OpenAI agents** (via API) | Reasoning + tool plans; calls MCP over HTTPS | OpenAI Responses API; your `OPENAI_API_KEY`. |

You do **not** run Playwright inside the automation container for browser sources. The model uses **remote MCP** to talk to `mcp-browser`.

## The three agents

1. **Listing collector** (implemented)  
   - **Uses MCP** (Playwright) for listing pages.  
   - Adapter `openai_listing_v1` → `src/automation/adapters/agentListing.js`.  
   - Output: `event_links[]`, `next_page_url`.

2. **Event detail extractor** (next)  
   - **Uses MCP** per event URL.  
   - Add adapter `openai_detail_v1` (same pattern as listing).  
   - Output: normalized Community Hub–oriented fields.

3. **Duplicate comparator** (implemented, optional)  
   - **No MCP** — compares JSON only: incoming staged event vs recent `events_staging` (other sources) + `community_hub_events`.  
   - `src/automation/agents/agentDedupe.js`; runs **after** `findDuplicateMatch` in SQL when `OPENAI_DEDUPE_ENABLED=true`.  
   - Only overrides to “duplicate” when the model returns `is_duplicate: true`, a matching URL, and `confidence` ≥ `OPENAI_DEDUPE_MIN_CONFIDENCE` (default `0.75`).

Agent Builder is still the best place to **prototype** prompts and tool use. When stable, keep the **same prompts** in code (as in `agentListing.js`) or paste exported SDK snippets next to the adapters.

## Environment variables (automation service)

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes, for listing agent + optional dedupe agent | OpenAI API key. |
| `MCP_BROWSER_URL` | Yes for `openai_listing_v1` | Public MCP URL, e.g. `https://<your-mcp-service>.onrender.com/mcp`. |
| `OPENAI_AGENT_MODEL` | No | Default `gpt-4.1` for listing. |
| `OPENAI_DEDUPE_ENABLED` | No | `true` to run duplicate comparator after SQL rules (default off). |
| `OPENAI_DEDUPE_MODEL` | No | Default `gpt-4.1-mini` (cheap; override for quality). |
| `OPENAI_DEDUPE_CONTEXT_LIMIT` | No | Max rows per bucket sent to the model (default `50`). |
| `OPENAI_DEDUPE_MIN_CONFIDENCE` | No | Min model `confidence` to mark duplicate (default `0.75`). |

Legacy alias: `PLAYWRIGHT_MCP_URL` is accepted if `MCP_BROWSER_URL` is unset.

## Source configuration

Use `adapter_key: "openai_listing_v1"` and the same `adapter_config` shape as the old browser listing (e.g. `max_links`, `allowed_hosts`). See `data/sources.example.json` for Experience Oberlin.

API and ICS sources (`localist_v1`, `ics_v1`) do **not** use agents or MCP.

## Operational notes

- **Cold start:** first OpenAI + MCP request after idle may hit Render spin-up; retry or warm the MCP service.  
- **Cost:** each listing run is at least one Responses call plus MCP tool traffic.  
- **Reliability:** if OpenAI returns `server_error`, check org/API access and MCP URL reachability from the public internet.
