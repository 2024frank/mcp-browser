#!/usr/bin/env node
/**
 * Pilot evaluation — small controlled batch + QA / completeness report.
 *
 * Runs one source with temporary caps (max_links, max_detail_extractions) without
 * changing the saved source row. After the run, summarizes staging rows touched
 * in that window: QA status, completeness, duplicate flags, and field presence.
 *
 * Usage (local — uses DATA_DIR / DB from .env + config.js):
 *   export OPENAI_API_KEY=...
 *   export MCP_BROWSER_URL=...
 *   npm run eval:pilot -- --source=experience-oberlin --max-links=3 --max-details=3 --log
 *
 * Usage (remote — automation server already running):
 *   npm run eval:pilot -- --source=experience-oberlin --base-url=https://your-host --max-links=3
 *
 * Weekly tracking: pass --log to append one JSON line per run to
 *   ${DATA_DIR}/pilot-eval-log.jsonl */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function parseArgs(argv) {
  const out = {
    source: process.env.PILOT_SOURCE_ID || null,
    maxLinks: Number(process.env.PILOT_MAX_LINKS || 3),
    maxDetails: Number(process.env.PILOT_MAX_DETAILS || 3),
    baseUrl: (process.env.EVAL_BASE_URL || "").replace(/\/$/, "") || null,
    log: process.env.PILOT_LOG === "1" || process.env.PILOT_LOG === "true",
    help: false
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--log") out.log = true;
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a.startsWith("--max-links=")) out.maxLinks = Number(a.slice("--max-links=".length)) || out.maxLinks;
    else if (a.startsWith("--max-details="))
      out.maxDetails = Number(a.slice("--max-details=".length)) || out.maxDetails;
    else if (a.startsWith("--base-url=")) out.baseUrl = a.slice("--base-url=".length).replace(/\/$/, "");
  }
  return out;
}

function summarizeRows(rows) {
  const qa = { pass: 0, repaired_pass: 0, rejected: 0, unknown: 0 };
  let compSum = 0;
  let compN = 0;
  let dups = 0;
  const requiredKeys = [
    "title",
    "organizational_sponsor",
    "start_datetime",
    "location_type",
    "source_event_url"
  ];
  const fieldPresent = Object.fromEntries(requiredKeys.map((k) => [k, 0]));

  for (const ev of rows) {
    const meta = ev.extraction_metadata || {};
    const q = meta.qa_status || "unknown";
    if (q === "pass") qa.pass += 1;
    else if (q === "repaired_pass") qa.repaired_pass += 1;
    else if (q === "rejected") qa.rejected += 1;
    else qa.unknown += 1;

    if (typeof meta.completeness_score === "number") {
      compSum += meta.completeness_score;
      compN += 1;
    }
    if (ev.is_duplicate) dups += 1;

    for (const k of requiredKeys) {
      const v = ev[k];
      if (v !== null && v !== undefined && String(v).trim() !== "") fieldPresent[k] += 1;
    }
  }

  return {
    n: rows.length,
    qa,
    avg_completeness: compN ? +((compSum / compN).toFixed(1)) : null,
    duplicate_flagged: dups,
    field_present_counts: fieldPresent,
    field_present_pct:
      rows.length > 0
        ? Object.fromEntries(
            requiredKeys.map((k) => [k, +((100 * fieldPresent[k]) / rows.length).toFixed(1)])
          )
        : {}
  };
}

function printReport(rows, summary) {
  console.log("\n--- Per-event (touched this run) ---\n");
  for (const ev of rows) {
    const meta = ev.extraction_metadata || {};
    const issues = Array.isArray(meta.qa_issues) ? meta.qa_issues : [];
    const issueStr = issues.length
      ? issues.map((i) => i.message || i.code).join("; ")
      : "—";
    console.log(
      [
        `id=${ev.id}`,
        `qa=${meta.qa_status || "unknown"}`,
        `C=${meta.completeness_score ?? "?"}`,
        `dup=${ev.is_duplicate ? "Y" : "N"}`,
        `title=${JSON.stringify((ev.title || "").slice(0, 60))}`
      ].join(" | ")
    );
    console.log(`  url: ${ev.source_event_url}`);
    console.log(`  qa_issues: ${issueStr}`);
  }

  console.log("\n--- Summary ---\n");
  console.log(JSON.stringify(summary, null, 2));
}

function appendLog(dataDir, record) {
  const file = path.join(dataDir, "pilot-eval-log.jsonl");
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  console.log(`\nAppended log line: ${file}`);
}

async function runRemote(baseUrl, sourceId, adapterConfig, runMarkMs) {
  const runUrl = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/run`;
  const res = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adapter_config: adapterConfig })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const stagUrl = `${baseUrl}/api/events-staging?sourceId=${encodeURIComponent(sourceId)}&limit=100`;
  const sr = await fetch(stagUrl);
  const sj = await sr.json();
  if (!sr.ok) {
    throw new Error(sj.error || `staging HTTP ${sr.status}`);
  }
  const events = sj.events_staging || [];
  let touched = events.filter((e) => new Date(e.updated_at).getTime() >= runMarkMs);
  if (touched.length === 0 && body.status === "success") {
    const k = Number(body.summary?.detail_extractions || body.upserted_events || 0);
    if (k > 0) touched = events.slice(0, Math.min(k, events.length));
  }
  return { runResult: body, touched };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    console.log(`Usage: npm run eval:pilot -- --source=<source_id> [options]

Options:
  --max-links=N     Cap listing collection (default ${process.env.PILOT_MAX_LINKS || 3})
  --max-details=N   Cap detail extractions per run (default ${process.env.PILOT_MAX_DETAILS || 3})
  --base-url=URL    Call running server (otherwise runs in-process with local DB)
  --log             Append JSON summary to \${DATA_DIR}/pilot-eval-log.jsonl
  --help

Requires OPENAI_API_KEY + MCP_BROWSER_URL for local in-process runs.
Remote mode only needs the server to have those set.`);
    process.exit(args.source ? 0 : 1);
  }

  const adapterConfig = {
    max_links: args.maxLinks,
    max_detail_extractions: args.maxDetails
  };

  const runMark = Date.now() - 2000;
  let runResult;
  let touched;
  let dataDir;

  if (args.baseUrl) {
    ({ runResult, touched } = await runRemote(args.baseUrl, args.source, adapterConfig, runMark));
    dataDir = process.env.DATA_DIR || path.join(root, "data/runtime");
  } else {
    const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
    const hasMcp = !!(process.env.MCP_BROWSER_URL || process.env.PLAYWRIGHT_MCP_URL || "").trim();
    if (!hasOpenAI || !hasMcp) {
      console.error("Local mode requires OPENAI_API_KEY and MCP_BROWSER_URL (or use --base-url).");
      process.exit(1);
    }

    const { config } = await import("../src/automation/config.js");
    const { createRepository } = await import("../src/automation/db.js");
    const { createAutomationService } = await import("../src/automation/service.js");

    dataDir = config.dataDir;
    const repository = createRepository(config);
    const automationService = createAutomationService(repository, config);

    runResult = await automationService.processSource(args.source, { adapter_config: adapterConfig });
    const events = repository.listStaging({ sourceId: args.source, limit: 100 });
    touched = events.filter((e) => new Date(e.updated_at).getTime() >= runMark);
    if (touched.length === 0 && runResult.status === "success") {
      const k = Number(runResult.summary?.detail_extractions || runResult.upserted_events || 0);
      if (k > 0) touched = events.slice(0, Math.min(k, events.length));
    }
  }

  console.log("\n--- Run result ---\n");
  console.log(JSON.stringify(runResult, null, 2));

  const summary = summarizeRows(touched);
  printReport(touched, summary);

  if (args.log) {
    appendLog(dataDir, {
      ts: new Date().toISOString(),
      source_id: args.source,
      adapter_config: adapterConfig,
      run: runResult,
      evaluation: summary,
      touched_event_ids: touched.map((e) => e.id)
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
