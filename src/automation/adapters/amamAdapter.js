/**
 * Listing adapter — Allen Memorial Art Museum (adapter: amam_camoufox_v1)
 * -----------------------------------------------------------------------
 * AMAM's events page is fully JavaScript-rendered (no static HTML events).
 * Camoufox (anti-detect headless Firefox) is used to render the page and
 * extract `a.event` elements which each contain the full event info inline.
 *
 * Returns fully-shaped stagedEvents — detail extraction step is skipped.
 */
import { Camoufox } from "camoufox-js";

import { mapNormalizedEventToCommunityHub } from "../community-hub.js";
import { makeFingerprint, truncateText } from "../utils.js";

const EVENTS_URL = "https://amam.oberlin.edu/exhibitions-events/events";
const DEFAULT_ADDRESS = "87 N. Main St., Oberlin, OH 44074";

/**
 * Parse the AMAM date line:
 * "TUESDAY, APRIL 14, 2026 AT 3:00 P.M. - 4:00 P.M."
 * Returns { start_datetime, end_datetime } as ISO strings or null.
 */
function parseAMAMDateLine(text) {
  if (!text) return { start_datetime: null, end_datetime: null };
  const m = text.match(
    /([A-Z]+),\s+([A-Z]+ \d+, \d{4})\s+AT\s+(\d+:\d+\s*[AP]\.M\.)\s*-\s*(\d+:\d+\s*[AP]\.M\.)/i
  );
  if (!m) return { start_datetime: null, end_datetime: null };

  const fixTime = (t) => t.replace(/\./g, "").replace(/\s+/g, "").trim();
  const startRaw = new Date(`${m[2]} ${fixTime(m[3])}`);
  const endRaw = new Date(`${m[2]} ${fixTime(m[4])}`);

  return {
    start_datetime: isNaN(startRaw.getTime()) ? null : startRaw.toISOString(),
    end_datetime: isNaN(endRaw.getTime()) ? null : endRaw.toISOString()
  };
}

export async function runAMAMAdapter(source, runtimeConfig) {
  const browser = await Camoufox({ headless: true });
  const page = await (await browser.newContext()).newPage();

  let rawEvents = [];
  try {
    await page.goto(EVENTS_URL, {
      waitUntil: "networkidle",
      timeout: 60_000
    });
    await page.waitForTimeout(4000);

    rawEvents = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a.event")).map((el) => {
        const lines = el.innerText
          .trim()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        // first line is short month abbreviation (e.g. "APR"), second is the day number,
        // third is the long date+time line, fourth is the title, rest is description.
        const dateLine = lines.find((l) => /[A-Z]+DAY,/.test(l)) || "";
        const titleIdx = lines.findIndex(
          (l) =>
            l.length > 5 &&
            !l.match(/^[A-Z]{2,4}$/) &&
            !l.match(/^\d{1,2}$/) &&
            !l.match(/[A-Z]+DAY,/) &&
            !l.match(/^AT /)
        );
        const title = titleIdx >= 0 ? lines[titleIdx] : "";
        const desc = titleIdx >= 0 ? lines.slice(titleIdx + 1).join(" ").trim() : "";
        return {
          href: el.href,
          dateLine,
          title,
          desc,
          img: el.querySelector("img")?.src || null
        };
      })
    );
  } finally {
    await browser.close();
  }

  const now = new Date().toISOString();
  const stagedEvents = rawEvents
    .filter((r) => r.title)
    .map((r) => {
      const { start_datetime, end_datetime } = parseAMAMDateLine(r.dateLine);
      if (start_datetime && start_datetime < now) return null;

      const normalizedEvent = {
        external_event_id: null,
        title: r.title,
        organizational_sponsor: source.attribution_label || source.source_name,
        event_type_categories: [],
        start_datetime,
        end_datetime,
        location_type: r.title.toLowerCase().includes("zoom") ? "Online" : "In-Person",
        location_or_address: r.title.toLowerCase().includes("zoom") ? null : DEFAULT_ADDRESS,
        room_number: null,
        event_link: r.href || EVENTS_URL,
        short_description: truncateText(r.desc, 200),
        extended_description: r.desc || null,
        artwork_url: r.img || null,
        source_name: source.source_name,
        source_domain: source.source_domain,
        source_listing_url: source.listing_url,
        source_event_url: r.href || EVENTS_URL,
        is_duplicate: null,
        duplicate_match_url: null,
        duplicate_reason: null,
        confidence: 0.9,
        review_status: "pending",
        raw_payload: r
      };

      normalizedEvent.community_hub_payload = mapNormalizedEventToCommunityHub(normalizedEvent);
      return normalizedEvent;
    })
    .filter(Boolean);

  const candidates = stagedEvents.map((e) => ({
    external_event_id: null,
    event_url: e.source_event_url,
    title_hint: e.title,
    fingerprint: makeFingerprint([source.id, e.source_event_url, e.start_datetime || ""]),
    raw_payload: { adapter: "amam_camoufox_v1" }
  }));

  return {
    candidates,
    stagedEvents,
    summary: {
      adapter: "amam_camoufox_v1",
      eligible_events: stagedEvents.length
    }
  };
}
