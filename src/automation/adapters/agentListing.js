import OpenAI from "openai";

import { makeFingerprint, parseModelJsonOutput } from "../utils.js";

/**
 * Listing collection via OpenAI Responses API + remote Playwright MCP.
 * Configure MCP_BROWSER_URL to your deployed mcp-browser service (…/mcp or …/sse).
 */
export async function runOpenAiListingAdapter(source, _runtimeConfig) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("openai_listing_v1 requires OPENAI_API_KEY on the automation service");
  }

  const mcpUrl = (process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
  if (!mcpUrl) {
    throw new Error(
      "openai_listing_v1 requires MCP_BROWSER_URL (e.g. https://<mcp-service>.onrender.com/mcp)"
    );
  }

  const model = process.env.OPENAI_AGENT_MODEL || "gpt-4.1";
  const adapterConfig = source.adapter_config || {};
  const maxLinks = Number(adapterConfig.max_links || 25);
  const allowedHosts = adapterConfig.allowed_hosts || [];

  const client = new OpenAI({ apiKey });
  const listingUrl = source.listing_url;
  const hostsLine =
    allowedHosts.length > 0
      ? `Only include links whose hostname is one of: ${allowedHosts.join(", ")}.`
      : "";

  const input = `You are a listing collector agent. Use the browser MCP tools for every navigation and snapshot.

Task:
1) Open this listing page: ${listingUrl}
2) After navigation, wait for meaningful content, then snapshot the page.
3) Collect up to ${maxLinks} links that point to individual event detail pages (not the listing page URL itself).
4) Ignore header, footer, navigation, filters, category pages, search, and social links.
${hostsLine}
5) If there is a clear "next page" link for the event listing pagination, return its absolute URL as next_page_url; otherwise return an empty string for next_page_url.

Output rules:
- Return a single JSON object only (no markdown fences).
- Shape: {"event_links":[{"title_hint":"string","event_url":"string"}],"next_page_url":"string"}
- event_url values must be absolute https URLs.
- title_hint should be the visible link text when available.`;

  const response = await client.responses.create({
    model,
    tools: [
      {
        type: "mcp",
        server_label: "playwright",
        server_description: "Playwright MCP for browser navigation and snapshots.",
        server_url: mcpUrl,
        require_approval: "never"
      }
    ],
    input
  });

  const text = response.output_text || "";
  let parsed;
  try {
    parsed = parseModelJsonOutput(text);
  } catch (e) {
    throw new Error(
      `openai_listing_v1: could not parse JSON from model (${e.message}). First 400 chars: ${text.slice(0, 400)}`
    );
  }

  const links = Array.isArray(parsed.event_links) ? parsed.event_links : [];
  const nextPageUrl = typeof parsed.next_page_url === "string" ? parsed.next_page_url : "";

  const candidates = [];
  const seen = new Set();
  for (const row of links) {
    if (candidates.length >= maxLinks) {
      break;
    }
    const eventUrl = row?.event_url;
    if (!eventUrl || typeof eventUrl !== "string") {
      continue;
    }
    if (seen.has(eventUrl)) {
      continue;
    }
    seen.add(eventUrl);
    candidates.push({
      external_event_id: null,
      event_url: eventUrl,
      title_hint: row.title_hint || null,
      fingerprint: makeFingerprint([source.id, eventUrl]),
      raw_payload: {
        title_hint: row.title_hint || null,
        event_url: eventUrl,
        adapter: "openai_listing_v1"
      }
    });
  }

  return {
    candidates,
    stagedEvents: [],
    summary: {
      adapter: "openai_listing_v1",
      eligible_events: candidates.length,
      next_page_url: nextPageUrl,
      model,
      mcp_host: new URL(mcpUrl).host
    }
  };
}
