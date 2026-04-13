function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function inferFaultAgent(issueCode) {
  if (issueCode.startsWith("missing_")) return "detail_extractor";
  if (issueCode.includes("hyperlocal")) return "hyperlocal_agent";
  if (issueCode.includes("duplicate")) return "dedupe_agent";
  return "detail_extractor";
}

async function checkUrl(url, timeoutMs = 6000) {
  if (!/^https?:\/\//i.test(String(url || ""))) {
    return { ok: false, status: 0, contentType: "", error: "not_http_url" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    } catch {
      response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      error: response.ok ? null : `http_${response.status}`
    };
  } catch (error) {
    return { ok: false, status: 0, contentType: "", error: error?.name || "request_error" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runQualityGateAgent(event, runtimeConfig = {}) {
  const issues = [];

  const requiredFields = [
    "title",
    "organizational_sponsor",
    "start_datetime",
    "location_type",
    "source_name",
    "source_event_url"
  ];
  for (const field of requiredFields) {
    if (!hasValue(event[field])) {
      issues.push({
        code: `missing_${field}`,
        field,
        message: `Missing required field: ${field}`,
        fault_agent: inferFaultAgent(`missing_${field}`)
      });
    }
  }

  const urlChecks = [
    ["source_event_url", event.source_event_url, false],
    ["event_link", event.event_link, false],
    ["artwork_url", event.artwork_url, true]
  ];
  const timeoutMs = Number(runtimeConfig.qualityGateUrlTimeoutMs || 6000);
  for (const [field, url, expectImage] of urlChecks) {
    if (!hasValue(url)) continue;
    const result = await checkUrl(url, timeoutMs);
    if (!result.ok) {
      issues.push({
        code: `broken_${field}`,
        field,
        message: `${field} is not reachable (${result.error || "unknown_error"})`,
        fault_agent: "detail_extractor"
      });
      continue;
    }
    if (expectImage && result.contentType && !String(result.contentType).toLowerCase().startsWith("image/")) {
      issues.push({
        code: "invalid_artwork_content_type",
        field,
        message: `artwork_url content-type is not image/* (${result.contentType})`,
        fault_agent: "detail_extractor"
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

