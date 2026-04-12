import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = String(process.env.PORT ?? 3000);
const mcpBin = fileURLToPath(new URL("./node_modules/.bin/playwright-mcp", import.meta.url));

const child = spawn(
  mcpBin,
  ["--port", port, "--host", "0.0.0.0", "--allowed-hosts", "*", "--headless"],
  { stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
