# Agents + automation integration

## Split of responsibilities

| Layer | What runs | Where |
|--------|-----------|--------|
| **Playwright MCP** (`mcp-browser` service) | Browser only: navigate, snapshot, click, etc. | Render web service; URL ends with `/mcp` (or `/sse`). |
| **Automation** (`oberlin-calendar-automation`) | SQLite, schedules, Localist/ICS, dedupe hooks, HTTP API | Render web service + disk. |
| **OpenAI agents** (via API) | Reasoning + tool plans; calls MCP over HTTPS | OpenAI Responses API; your `OPENAI_API_KEY`. |

You do **not** run Playwright inside the automation container for browser sources. The model uses **remote MCP** to talk to `mcp-browser`.

## Which agents to build (recommended set)

1. **Listing collector** (implemented here as adapter `openai_listing_v1`)  
   - Input: `listing_url`, `max_links`, optional `allowed_hosts`.  
   - Output: `event_links[]`, `next_page_url`.  
   - Wired: `src/automation/adapters/agentListing.js` → `POST /api/sources/:id/run`.

2. **Event detail extractor** (next build)  
   - Input: one `event_url` (+ source metadata).  
   - Output: normalized fields matching `schemas/normalized_event.schema.json` / Community Hub mapping.  
   - Integration: add `openai_detail_v1` adapter (same pattern as listing); optionally run in a second pass after candidates exist in DB.

3. **Duplicate / review helper** (optional, later)  
   - Input: two event records (staged vs hub).  
   - Output: `likely_duplicate`, `reason`, `suggested_action`.  
   - Integration: batch job or `POST /api/.../review`—keep deterministic rules first, use the agent only for fuzzy cases.

Agent Builder is still the best place to **prototype** prompts and tool use. When stable, keep the **same prompts** in code (as in `agentListing.js`) or paste exported SDK snippets next to the adapters.

## Environment variables (automation service)

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes, for browser sources via agent | OpenAI API key. |
| `MCP_BROWSER_URL` | Yes | Public MCP URL, e.g. `https://<your-mcp-service>.onrender.com/mcp`. |
| `OPENAI_AGENT_MODEL` | No | Default `gpt-4.1`. |

Legacy alias: `PLAYWRIGHT_MCP_URL` is accepted if `MCP_BROWSER_URL` is unset.

## Source configuration

Use `adapter_key: "openai_listing_v1"` and the same `adapter_config` shape as the old browser listing (e.g. `max_links`, `allowed_hosts`). See `data/sources.example.json` for Experience Oberlin.

API and ICS sources (`localist_v1`, `ics_v1`) do **not** use agents or MCP.

## Operational notes

- **Cold start:** first OpenAI + MCP request after idle may hit Render spin-up; retry or warm the MCP service.  
- **Cost:** each listing run is at least one Responses call plus MCP tool traffic.  
- **Reliability:** if OpenAI returns `server_error`, check org/API access and MCP URL reachability from the public internet.
