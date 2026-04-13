import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

/** True if parsed start time is strictly before (now - graceMs). Invalid/missing dates → false. */
export function isEventStartInPast(startDatetimeIso, graceMs = 0) {
  if (!startDatetimeIso || String(startDatetimeIso).trim() === "") {
    return false;
  }
  const t = new Date(startDatetimeIso).getTime();
  if (Number.isNaN(t)) {
    return false;
  }
  return t < Date.now() - Math.max(0, Number(graceMs) || 0);
}

export function addMinutes(isoString, minutes) {
  return new Date(new Date(isoString).getTime() + minutes * 60_000).toISOString();
}

export function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toBool(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function truncateText(value, maxLength) {
  if (!value) {
    return null;
  }

  const trimmed = String(value).replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

export function stripHtml(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(url, baseUrl) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Stable form for comparing event URLs across sources and the hub mirror (trailing slashes,
 * hostname case). Does not change path case (servers may be case-sensitive).
 */
export function normalizeCanonicalEventUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function makeFingerprint(parts) {
  const hash = crypto.createHash("sha256");
  hash.update(parts.filter(Boolean).join("||"));
  return hash.digest("hex");
}

export function eventTitleKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dateInTimeZone(timeZone = "America/New_York", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/**
 * Parse JSON from model output that may include:
 *  - plain JSON object/array
 *  - ```json ... ``` fenced block
 *  - trailing prose after the JSON closes  (e.g. "Here is the result:\n{...}\nLet me know...")
 *  - leading prose before the JSON starts
 */
export function parseModelJsonOutput(text) {
  if (!text || typeof text !== "string") {
    throw new Error("empty model output");
  }

  // 1. Strip ```json ... ``` fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    return JSON.parse(fence[1].trim());
  }

  // 2. Try the whole text first (common case — model returns clean JSON)
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // 3. Extract the first complete JSON object or array by tracking brace depth.
  //    Handles trailing prose, leading explanation, multi-line text, etc.
  const start = trimmed.search(/[{[]/);
  if (start === -1) throw new Error("no JSON object or array found in model output");

  const opener = trimmed[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape)            { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"')        { inString = !inString; continue; }
    if (inString)          continue;
    if (ch === opener)     depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
  }

  throw new Error("unterminated JSON in model output");
}
