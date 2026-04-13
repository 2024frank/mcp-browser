/**
 * Fetch ALL events from EVERY source with all Community Hub fields:
 *   title, start_datetime, end_datetime, location_or_address,
 *   short_description, extended_description, artwork_url,
 *   event_link, organizational_sponsor, source_event_url
 *
 * Sources covered:
 *   1. Oberlin Heritage Center  — WordPress AJAX JSON (no browser needed)
 *   2. FAVA                     — HTML scrape (cheerio, no browser needed)
 *   3. AMAM                     — Camoufox (JS-rendered)
 *   4. Oberlin Business Partner — Camoufox (Cloudflare-protected)
 *   5. Apollo Theatre           — HTML scrape (no browser needed)
 *   6. Oberlin Public Library   — Camoufox (whofi iframe, JS-rendered)
 *
 * Usage:
 *   npm run fetch:all-sources
 *   npm run fetch:all-sources -- --json
 *   npm run fetch:all-sources -- --source heritage
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { Camoufox } from "camoufox-js";

// Load .env
const __dir = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(__dir, "../.env"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* ignore */ }

const jsonOutput = process.argv.includes("--json");
const onlySource = process.argv.find((a, i) => process.argv[i - 1] === "--source");
const log = (...a) => { if (!jsonOutput) console.error(...a); };

function nowIso() { return new Date().toISOString(); }

function parseDateTime(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function stripHtml(html) {
  if (!html) return null;
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function extractSrc(html) {
  const m = String(html || "").match(/src="([^"]+)"/);
  return m ? m[1] : null;
}

function extractHref(html) {
  const m = String(html || "").match(/href="([^"]+)"/);
  return m ? m[1] : null;
}

// ─── Shared camoufox browser (lazy, one instance for all JS-rendered sources) ─
let _browser = null;
async function getBrowser() {
  if (!_browser) {
    log("Launching camoufox anti-detect browser...");
    _browser = await Camoufox({ headless: true });
  }
  return _browser;
}

// ─── 1. Oberlin Heritage Center — WordPress AJAX JSON ─────────────────────────
async function fetchHeritageCenter() {
  log("\n[1] Oberlin Heritage Center (WordPress AJAX)...");
  const res = await fetch(
    "https://www.oberlinheritagecenter.org/wp-admin/admin-ajax.php?action=fetch_Events",
    {
      headers: {
        Referer: "https://www.oberlinheritagecenter.org/events/",
        "User-Agent": "Mozilla/5.0 (compatible; oberlin-calendar/1.0)"
      },
      signal: AbortSignal.timeout(30000)
    }
  );
  if (!res.ok) throw new Error(`Heritage Center API ${res.status}`);
  const events = await res.json();
  const now = new Date().toISOString().slice(0, 10);

  return events
    .filter(e => e.start >= now)
    .map(e => ({
      source: "Oberlin Heritage Center",
      source_event_url: extractHref(e.title) || "https://www.oberlinheritagecenter.org/events/",
      title: stripHtml(e.title),
      start_datetime: parseDateTime(e.start),
      end_datetime: parseDateTime(e.end) || parseDateTime(e.start),
      location_or_address: [e.street, e.locality, e.state, e.postal].filter(Boolean).join(", ") || "23 S. Main St., Oberlin, OH 44074",
      location_type: "In-Person",
      short_description: stripHtml(e.post_event_excerpt)?.slice(0, 200) || null,
      extended_description: stripHtml(e.post_event_excerpt) || null,
      artwork_url: extractSrc(e.feature_image_calendar) || null,
      organizational_sponsor: "Oberlin Heritage Center",
      event_link: extractHref(e.title) || "https://www.oberlinheritagecenter.org/events/",
    }));
}

// ─── 2. FAVA — HTML scrape via cheerio ────────────────────────────────────────
async function fetchFAVA() {
  log("\n[2] FAVA Gallery (HTML scrape)...");
  const res = await fetch("https://www.favagallery.org/calendar", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; oberlin-calendar/1.0)" },
    signal: AbortSignal.timeout(30000)
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const events = [];

  // Each event card: div.bottom contains p.date + h3/h4/h5 title + link
  $("p.date").each((_, el) => {
    const card = $(el).closest("li,div,article,section");
    const dateStr = $(el).text().trim();
    const titleEl = card.find("h2,h3,h4,h5,.title").first();
    const title = titleEl.text().trim();
    const link = card.find("a[href]").first().attr("href") || "https://www.favagallery.org/calendar";
    // Image is usually in a sibling .top div or the card itself
    const img = card.parent().find("img").first().attr("src")
             || card.find("img").first().attr("src")
             || null;
    const desc = card.find("p:not(.date)").first().text().trim() || null;
    if (!title) return;
    events.push({
      source: "FAVA",
      source_event_url: link,
      title,
      start_datetime: parseDateTime(dateStr),
      end_datetime: parseDateTime(dateStr),
      location_or_address: "39 S. Main St., Oberlin, OH 44074",
      location_type: "In-Person",
      short_description: desc?.slice(0, 200) || null,
      extended_description: desc || null,
      artwork_url: img,
      organizational_sponsor: "FAVA",
      event_link: link,
    });
  });
  return events;
}

// ─── 3. AMAM — Camoufox JS-rendered ──────────────────────────────────────────
async function fetchAMAM() {
  log("\n[3] Allen Memorial Art Museum (Camoufox JS-rendered)...");
  const browser = await getBrowser();
  const page = await (await browser.newContext()).newPage();
  try {
    await page.goto("https://amam.oberlin.edu/exhibitions-events/events", {
      waitUntil: "networkidle", timeout: 45000
    });
    await page.waitForTimeout(4000);
    return await page.evaluate(() => {
      const parseAMAMDate = (text) => {
        // e.g. "TUESDAY, APRIL 14, 2026 AT 3:00 P.M. - 4:00 P.M."
        const m = text.match(/([A-Z]+),\s+([A-Z]+ \d+, \d{4})\s+AT\s+(\d+:\d+\s*[AP]\.M\.)\s*-\s*(\d+:\d+\s*[AP]\.M\.)/i);
        if (!m) return { start: null, end: null };
        const fix = t => t.replace(/\./g, "").replace(" M", "M").trim();
        const base = new Date(`${m[2]} ${fix(m[3])}`);
        const end = new Date(`${m[2]} ${fix(m[4])}`);
        return {
          start: isNaN(base.getTime()) ? null : base.toISOString(),
          end: isNaN(end.getTime()) ? null : end.toISOString()
        };
      };
      return Array.from(document.querySelectorAll("a.event")).map(el => {
        const raw = el.innerText.trim();
        const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
        const dateLine = lines.find(l => /[A-Z]+DAY,/.test(l)) || "";
        const title = lines.find(l => l.length > 5 && !l.match(/^[A-Z]{3}$/) && !l.match(/[A-Z]+DAY,/) && !l.match(/^AT /)) || lines[3] || "";
        const desc = lines.slice(lines.indexOf(title) + 1).join(" ").trim();
        const { start, end } = parseAMAMDate(dateLine);
        return {
          source: "Allen Memorial Art Museum",
          source_event_url: el.href,
          title: title.trim(),
          start_datetime: start,
          end_datetime: end,
          location_or_address: "87 N. Main St., Oberlin, OH 44074",
          location_type: "In-Person",
          short_description: desc.slice(0, 200) || null,
          extended_description: desc || null,
          artwork_url: el.querySelector("img")?.src || null,
          organizational_sponsor: "Allen Memorial Art Museum",
          event_link: el.href,
        };
      }).filter(e => e.title);
    });
  } finally {
    await page.close();
  }
}

// ─── 4. Oberlin Business Partnership — Camoufox (Cloudflare) ─────────────────
async function fetchOBP() {
  log("\n[4] Oberlin Business Partnership (Camoufox)...");
  const browser = await getBrowser();
  const page = await (await browser.newContext()).newPage();
  try {
    await page.goto("https://www.oberlinbusinesspartnership.com/calendar/", {
      waitUntil: "domcontentloaded", timeout: 45000
    });
    await page.waitForTimeout(8000);
    return await page.evaluate(() => {
      const events = [];
      document.querySelectorAll(".eventWrapper,.event-card,.tribe-event,.post-card,[class*=event]").forEach(el => {
        const title = el.querySelector("h1,h2,h3,h4,.title,a")?.innerText?.trim();
        if (!title || title.length < 3) return;
        const date = el.querySelector("time,.date,.tribe-event-date-start,[class*=date]")?.innerText?.trim();
        const desc = el.querySelector("p,.description,.excerpt")?.innerText?.trim();
        const img = el.querySelector("img")?.src;
        const link = el.querySelector("a")?.href;
        events.push({
          source: "Oberlin Business Partnership",
          source_event_url: link || "https://www.oberlinbusinesspartnership.com/calendar/",
          title,
          start_datetime: date ? new Date(date).toISOString() : null,
          end_datetime: null,
          location_or_address: "Oberlin, OH 44074",
          location_type: "In-Person",
          short_description: desc?.slice(0, 200) || null,
          extended_description: desc || null,
          artwork_url: img || null,
          organizational_sponsor: "Oberlin Business Partnership",
          event_link: link || null,
        });
      });
      return events;
    });
  } finally {
    await page.close();
  }
}

// ─── 5. Apollo Theatre — HTML scrape for showtimes ───────────────────────────
async function fetchApollo() {
  log("\n[5] Apollo Theatre / Cleveland Cinemas (HTML scrape)...");
  const res = await fetch(
    "https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/",
    {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; oberlin-calendar/1.0)" },
      signal: AbortSignal.timeout(30000)
    }
  );
  // Gatsby page-data JSON for showtimes
  const pageData = await fetch(
    "https://www.clevelandcinemas.com/page-data/our-locations/x03gq-apollo-theatre/page-data.json",
    { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) }
  ).then(r => r.json()).catch(() => null);

  const events = [];
  if (pageData) {
    // Extract movies from Gatsby data
    const widgets = pageData?.result?.data?.page?.widgets || [];
    widgets.forEach(w => {
      if (w.moviesShape || w.__typename?.includes("Movie")) {
        const movies = w.moviesShape?.movies || [];
        movies.forEach(m => {
          if (m?.title) {
            events.push({
              source: "Apollo Theatre",
              source_event_url: `https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/`,
              title: `${m.title} — Apollo Theatre Screening`,
              start_datetime: null,
              end_datetime: null,
              location_or_address: "19 E. College St., Oberlin, OH 44074",
              location_type: "In-Person",
              short_description: m.synopsis?.slice(0, 200) || null,
              extended_description: m.synopsis || null,
              artwork_url: m.posterImage || m.backdropImage || null,
              organizational_sponsor: "Apollo Theatre",
              event_link: "https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/",
            });
          }
        });
      }
    });
  }

  if (events.length === 0) {
    // Fallback: HTML parse for movie titles
    const html = await res.text();
    const $ = cheerio.load(html);
    $("h2,h3").each((_, el) => {
      const title = $(el).text().trim();
      if (title && title.length > 3 && !title.includes("Apollo") && !title.includes("Cleveland")) {
        events.push({
          source: "Apollo Theatre",
          source_event_url: "https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/",
          title: `${title} — Apollo Theatre Screening`,
          start_datetime: null,
          end_datetime: null,
          location_or_address: "19 E. College St., Oberlin, OH 44074",
          location_type: "In-Person",
          short_description: null,
          extended_description: null,
          artwork_url: $(el).parent().find("img").first().attr("src") || null,
          organizational_sponsor: "Apollo Theatre",
          event_link: "https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/",
        });
      }
    });
  }
  return events;
}

// ─── 6. Oberlin Public Library — Camoufox (whofi iframe) ─────────────────────
async function fetchLibrary() {
  log("\n[6] Oberlin Public Library (Camoufox whofi calendar)...");
  const browser = await getBrowser();
  const page = await (await browser.newContext()).newPage();
  try {
    await page.goto("https://www.oberlinlibrary.org/events", {
      waitUntil: "networkidle", timeout: 60000
    });
    await page.waitForTimeout(8000);

    // Try main page events first
    let events = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".eventitem-wrapper,.event,.sqs-events")).map(el => ({
        title: el.querySelector("h1,h2,h3,.eventitem-title")?.innerText?.trim(),
        date: el.querySelector("time,.event-date,.eventitem-meta-date")?.innerText?.trim(),
        desc: el.querySelector("p,.eventitem-description")?.innerText?.trim(),
        img: el.querySelector("img")?.src,
        link: el.querySelector("a")?.href,
      })).filter(e => e.title);
    });

    // Fallback: check whofi iframe
    if (events.length === 0) {
      const frames = page.frames();
      const whofi = frames.find(f => f.url().includes("whofi"));
      if (whofi) {
        events = await whofi.evaluate(() => {
          return Array.from(document.querySelectorAll(".event,.event-item,.fc-event,td.fc-event-container")).map(el => ({
            title: el.querySelector(".event-title,.fc-title,.title")?.innerText?.trim() || el.innerText?.trim().slice(0, 60),
            date: el.querySelector(".event-date,time")?.innerText?.trim(),
            link: el.querySelector("a")?.href,
          })).filter(e => e.title).slice(0, 30);
        });
      }
    }

    return events.map(e => ({
      source: "Oberlin Public Library",
      source_event_url: e.link || "https://www.oberlinlibrary.org/events",
      title: e.title,
      start_datetime: e.date ? new Date(e.date).toISOString() : null,
      end_datetime: null,
      location_or_address: "65 S. Main St., Oberlin, OH 44074",
      location_type: "In-Person",
      short_description: e.desc?.slice(0, 200) || null,
      extended_description: e.desc || null,
      artwork_url: e.img || null,
      organizational_sponsor: "Oberlin Public Library",
      event_link: e.link || "https://www.oberlinlibrary.org/events",
    }));
  } finally {
    await page.close();
  }
}

// ─── Run all sources ──────────────────────────────────────────────────────────
const SOURCE_MAP = {
  heritage: fetchHeritageCenter,
  fava: fetchFAVA,
  amam: fetchAMAM,
  obp: fetchOBP,
  apollo: fetchApollo,
  library: fetchLibrary,
};

const toRun = onlySource
  ? (SOURCE_MAP[onlySource.toLowerCase()] ? [SOURCE_MAP[onlySource.toLowerCase()]] : [])
  : Object.values(SOURCE_MAP);

if (onlySource && !SOURCE_MAP[onlySource.toLowerCase()]) {
  console.error(`Unknown source: ${onlySource}. Valid: ${Object.keys(SOURCE_MAP).join(", ")}`);
  process.exit(1);
}

const allEvents = [];
const errors = [];

for (const fn of toRun) {
  try {
    const events = await fn();
    log(`  → ${events.length} events`);
    allEvents.push(...events);
  } catch (err) {
    log(`  ERROR: ${err.message}`);
    errors.push({ source: fn.name, error: err.message });
  }
}

if (_browser) await _browser.close();

if (jsonOutput) {
  console.log(JSON.stringify({ total: allEvents.length, errors, events: allEvents }, null, 2));
} else {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`ALL SOURCES — ${allEvents.length} TOTAL EVENTS`);
  console.log("=".repeat(70));

  const bySource = {};
  for (const e of allEvents) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
  }
  Object.entries(bySource).forEach(([s, n]) => console.log(`  ${s}: ${n}`));
  console.log("");

  allEvents.forEach((ev, i) => {
    console.log(`\n[${i + 1}] ${ev.title}`);
    console.log(`    Source:    ${ev.source}`);
    if (ev.start_datetime) console.log(`    Start:     ${ev.start_datetime}`);
    if (ev.end_datetime)   console.log(`    End:       ${ev.end_datetime}`);
    if (ev.location_or_address) console.log(`    Where:     ${ev.location_or_address}`);
    if (ev.short_description)   console.log(`    Desc:      ${ev.short_description.slice(0, 100)}`);
    if (ev.artwork_url)         console.log(`    Image:     ${ev.artwork_url.slice(0, 80)}`);
    if (ev.source_event_url)    console.log(`    URL:       ${ev.source_event_url}`);
  });

  if (errors.length) {
    console.log("\n--- ERRORS ---");
    errors.forEach(e => console.log(`  ${e.source}: ${e.error}`));
  }
}
