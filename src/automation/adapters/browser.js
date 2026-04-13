/**
 * Listing collector — local Playwright + Cheerio (adapter: browser_listing_v1)
 * -----------------------------------------------------------------------------
 * Fetches listing HTML in-process, parses links matching source URL patterns,
 * returns event candidates. No OpenAI; fault_agent for review issues: listing_agent.
 */
import * as cheerio from "cheerio";
import { chromium } from "playwright";

import { makeFingerprint, normalizeUrl } from "../utils.js";

function compilePattern(value) {
  if (!value) {
    return /\/event\//i;
  }

  if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const lastSlash = value.lastIndexOf("/");
    const body = value.slice(1, lastSlash);
    const flags = value.slice(lastSlash + 1);
    return new RegExp(body, flags);
  }

  return new RegExp(value, "i");
}

function hostMatches(url, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) {
    return true;
  }

  return allowedHosts.includes(new URL(url).hostname);
}

async function getRenderedHtml(source, runtimeConfig) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1280,
        height: 800
      }
    });
    await page.goto(source.listing_url, {
      waitUntil: "domcontentloaded",
      timeout: runtimeConfig.requestTimeoutMs
    });
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(runtimeConfig.requestTimeoutMs, 10_000)
    }).catch(() => {});
    await page.waitForTimeout(1500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

export async function runBrowserListingAdapter(source, runtimeConfig) {
  const adapterConfig = source.adapter_config || {};
  let html;
  try {
    html = await getRenderedHtml(source, runtimeConfig);
  } catch {
    const response = await fetch(source.listing_url, {
      headers: {
        "user-agent": runtimeConfig.userAgent
      },
      signal: AbortSignal.timeout(runtimeConfig.requestTimeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Browser listing request failed for ${source.source_name}: ${response.status}`);
    }

    html = await response.text();
  }

  const $ = cheerio.load(html);
  const pattern = compilePattern(adapterConfig.link_pattern);
  const allowedHosts = adapterConfig.allowed_hosts || [];
  const maxLinks = Number(adapterConfig.max_links || 25);
  const seen = new Set();
  const candidates = [];

  $("a[href]").each((_, element) => {
    if (candidates.length >= maxLinks) {
      return;
    }

    const href = $(element).attr("href");
    const eventUrl = normalizeUrl(href, source.listing_url);
    const titleHint = ($(element).text() || $(element).attr("title") || "").trim();

    if (!eventUrl || eventUrl === source.listing_url) {
      return;
    }
    if (!eventUrl.startsWith("http")) {
      return;
    }
    if (!hostMatches(eventUrl, allowedHosts)) {
      return;
    }
    if (!pattern.test(eventUrl) && !pattern.test(titleHint)) {
      return;
    }
    if (seen.has(eventUrl)) {
      return;
    }

    seen.add(eventUrl);
    candidates.push({
      external_event_id: null,
      event_url: eventUrl,
      title_hint: titleHint || null,
      fingerprint: makeFingerprint([source.id, eventUrl]),
      raw_payload: {
        title_hint: titleHint || null,
        event_url: eventUrl
      }
    });
  });

  let nextPageUrl = "";
  const nextLink = $("a[rel='next']").first();
  if (nextLink.length > 0) {
    nextPageUrl = normalizeUrl(nextLink.attr("href"), source.listing_url) || "";
  }

  return {
    candidates,
    stagedEvents: [],
    summary: {
      adapter: "browser_listing_v1",
      eligible_events: candidates.length,
      next_page_url: nextPageUrl,
      pages_scanned: 1
    }
  };
}
