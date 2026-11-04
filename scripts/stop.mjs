#!/usr/bin/env node
// Stops the processes started by start.mjs (and their browser children). Pass --keep-n8n to leave n8n running.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = path.join(ROOT, "var", "pids.json");

if (fs.existsSync(pidFile)) {
  for (const { name, pid } of JSON.parse(fs.readFileSync(pidFile, "utf8"))) {
    try {
      execSync(process.platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`, { stdio: "ignore" });
      process.stdout.write(`stopped ${name} (${pid})\n`);
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(pidFile);
}
// Fallback: any leftover node process of this project started some other way (Windows only).
if (process.platform === "win32") {
  const ps =
    "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | " +
    "Where-Object { $_.CommandLine -match 'complaint-agent' -and $_.CommandLine -match 'legacy.server.ts|src.server.ts|rpa.worker.ts' -and $_.ProcessId -ne " +
    process.pid +
    " } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null; $_.ProcessId }";
  const left = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8" }).trim();
  if (left) process.stdout.write(`stopped leftover processes: ${left.split(/\s+/).join(", ")}\n`);
}
if (!process.argv.includes("--keep-n8n")) {
  execSync(`node "${path.join(ROOT, "scripts", "n8n.mjs")}" down`, { stdio: "inherit" });
}
