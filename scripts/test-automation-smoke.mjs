#!/usr/bin/env node
/**
 * Smoke test: automation modules load + optional HTTP /health (no OpenAI calls).
 * Usage: node scripts/test-automation-smoke.mjs
 * With server: PORT=4011 node src/automation/server.js &  node scripts/test-automation-smoke.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  console.log("1) Import automation modules…");
  await import("../src/automation/config.js");
  await import("../src/automation/utils.js");
  await import("../src/automation/community-hub.js");
  await import("../src/automation/adapters/agentListing.js");
  await import("../src/automation/adapters/agentDetail.js");
  await import("../src/automation/agents/agentDedupe.js");
  await import("../src/automation/service.js");
  console.log("   OK\n");

  const port = process.env.TEST_PORT || "4011";
  const serverPath = path.join(root, "src", "automation", "server.js");

  console.log(`2) Start server on PORT=${port} (3s)…`);
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: port, POLLER_ENABLED: "false", AUTO_SEED_SOURCES: "false" },
    stdio: "pipe"
  });

  let stderr = "";
  child.stderr?.on("data", (c) => {
    stderr += c.toString();
  });

  await new Promise((r) => setTimeout(r, 2500));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!body.ok) {
      throw new Error("health body.ok false");
    }
    console.log("   /health:", JSON.stringify(body).slice(0, 200), "… OK\n");
  } catch (e) {
    console.error("   /health failed:", e.message);
    if (stderr) {
      console.error("   server stderr:", stderr.slice(0, 500));
    }
    child.kill("SIGTERM");
    process.exit(1);
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));

  console.log("Smoke test passed (imports + /health).");
  console.log("OpenAI+MCP agents are not invoked here — test those in Agent Builder or with a real run + small max_links.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
