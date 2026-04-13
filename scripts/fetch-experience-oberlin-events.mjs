/**
 * Fetch ALL events from Experience Oberlin (Locable widget) using Camoufox
 * (anti-detect Firefox — bypasses Cloudflare Turnstile without API key).
 *
 * Usage:
 *   npm run fetch:experience-oberlin
 *   npm run fetch:experience-oberlin -- --json   # machine-readable JSON output
 *
 * Requires: camoufox binary (run `npx camoufox fetch` once to install).
 */
import { Camoufox } from "camoufox-js";

const WIDGET_URL =
  "https://impact.locable.com/widgets/calendar_widgets/631e0720-c220-45d6-868f-6e33134d9dbb?view=list";
const MAX_PAGES = 50; // safety cap (370 events ÷ ~12 per page ≈ 31 pages)
const jsonOutput = process.argv.includes("--json");

function log(...args) {
  if (!jsonOutput) console.error(...args);
}

function extractEventsFromPage() {
  const items = document.querySelectorAll(".list-item");
  const events = [];
  items.forEach((item) => {
    const title = item.querySelector(".title")?.innerText?.trim() || null;
    const datetime = item.querySelector(".start-datetime")?.innerText?.trim() || null;
    const location = item.querySelector(".location")?.innerText?.trim() || null;
    const description = item.querySelector(".description")?.innerText?.trim() || null;
    const readMore = item.querySelector("a.read-more, a[href*='locable']");
    const link = readMore?.href || null;
    const postedBy = item.querySelector(".product-desc")?.innerText?.trim() || null;
    if (title) {
      events.push({ title, datetime, location, description, link, posted_by: postedBy });
    }
  });
  return events;
}

const browser = await Camoufox({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const allEvents = [];
let currentPage = 1;

log(`Opening ${WIDGET_URL}`);
await page.goto(WIDGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);

for (;;) {
  log(`Scraping page ${currentPage}…`);

  const events = await page.evaluate(() => {
    const items = document.querySelectorAll(".list-item");
    const out = [];
    items.forEach((item) => {
      const title = item.querySelector(".title a, .title")?.innerText?.trim() || null;
      const datetime = item.querySelector(".start-datetime")?.innerText?.trim() || null;
      const location = item.querySelector(".location")?.innerText?.trim() || null;
      // description is the first .description text only (not nested children duplicating other fields)
      const descEl = item.querySelector(".description");
      const description = descEl ? descEl.childNodes[0]?.textContent?.trim() || descEl.innerText?.trim() : null;
      const readMore = item.querySelector("a.read-more");
      const link = readMore?.href || null;
      // posted_by is usually in a small sub-element, not the whole card
      const postedByEl = item.querySelector(".posted-by, .source-label, small");
      const postedBy = postedByEl ? postedByEl.innerText?.trim() : null;
      if (title) out.push({ title, datetime, location, description: description?.slice(0, 300) || null, link, posted_by: postedBy });
    });
    return out;
  });
  log(`  Found ${events.length} events on page ${currentPage}`);
  allEvents.push(...events);

  // Check for "Next" pagination link that is not disabled
  const hasNext = await page.evaluate(() => {
    const li = document.querySelector("li.next");
    return !!li && !li.classList.contains("disabled");
  });

  if (!hasNext || currentPage >= MAX_PAGES) {
    log(`Reached last page (${currentPage}).`);
    break;
  }

  // Click the Next link *inside* the already-trusted page (avoids Cloudflare re-challenge)
  log(`  Clicking Next…`);
  const prevFirstTitle = await page.evaluate(
    () => document.querySelector(".list-item .title")?.innerText?.trim()
  );
  await page.click("li.next a");
  // Wait until the first event title changes (new page loaded)
  await page.waitForFunction(
    (prev) => document.querySelector(".list-item .title")?.innerText?.trim() !== prev,
    prevFirstTitle,
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);
  currentPage += 1;
}

await browser.close();

log(`\nTotal events fetched: ${allEvents.length}`);

if (jsonOutput) {
  console.log(JSON.stringify(allEvents, null, 2));
} else {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`EXPERIENCE OBERLIN — ${allEvents.length} EVENTS`);
  console.log("=".repeat(60));
  allEvents.forEach((ev, i) => {
    console.log(`\n[${i + 1}] ${ev.title}`);
    if (ev.datetime)  console.log(`    When:     ${ev.datetime}`);
    if (ev.location)  console.log(`    Where:    ${ev.location}`);
    if (ev.posted_by) console.log(`    Posted:   ${ev.posted_by}`);
    if (ev.description) console.log(`    Desc:     ${ev.description.slice(0, 120)}`);
  });
}
