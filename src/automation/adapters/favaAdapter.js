/**
 * Listing adapter — FAVA Gallery (adapter: fava_v1)
 * --------------------------------------------------
 * FAVA's calendar renders in plain HTML — no JS rendering required. Events
 * are structured as: month header (h2/h3) → event cards, each with a
 * `p.date`, a title link, and an optional image in a sibling `.top` div.
 *
 * This adapter returns CANDIDATES (event detail URLs) so that the existing
 * `agentDetail` extractor (MCP + LLM) can visit each page and fill in the
 * full description, time, and proper image. This gives better field coverage
 * than trying to parse everything from the list view.
 *
 * Each event detail URL looks like:
 *   https://www.favagallery.org/classes/2026/04/14/event-slug
 */
import * as cheerio from "cheerio";

import { makeFingerprint } from "../utils.js";

const CALENDAR_URL = "https://www.favagallery.org/calendar";

export async function runFAVAAdapter(source, runtimeConfig) {
  const res = await fetch(CALENDAR_URL, {
    headers: {
      "User-Agent": runtimeConfig.userAgent || "oberlin-unified-calendar/0.1",
      Accept: "text/html"
    },
    signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMs ?? 30_000)
  });

  if (!res.ok) {
    throw new Error(`FAVA calendar returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const now = new Date().toISOString().slice(0, 10);
  const candidates = [];
  const seen = new Set();

  $("p.date").each((_, el) => {
    const card = $(el).closest("li,div,article,section");
    const dateStr = $(el).text().trim();

    // Skip past events
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) < now) {
      return;
    }

    const link = card.find("a[href]").first().attr("href");
    if (!link || seen.has(link)) return;
    seen.add(link);

    const titleText =
      card.find("h2,h3,h4,h5,.title").first().text().trim() ||
      card.find("a").first().text().trim() ||
      null;

    // Try to find image in the parent container (sibling .top div)
    const img =
      card.parent().find("img").first().attr("src") ||
      card.find("img").first().attr("src") ||
      null;

    candidates.push({
      external_event_id: null,
      event_url: link,
      title_hint: titleText,
      fingerprint: makeFingerprint([source.id, link]),
      raw_payload: {
        adapter: "fava_v1",
        date_hint: dateStr,
        img_hint: img
      }
    });
  });

  return {
    candidates,
    stagedEvents: [],
    summary: {
      adapter: "fava_v1",
      eligible_events: candidates.length
    }
  };
}
