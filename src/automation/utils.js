import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
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

/** Parse JSON from model output (plain or ```json fenced). */
export function parseModelJsonOutput(text) {
  if (!text || typeof text !== "string") {
    throw new Error("empty model output");
  }
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : trimmed).trim();
  return JSON.parse(body);
}
