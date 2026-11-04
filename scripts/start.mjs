#!/usr/bin/env node
// One command to start the demo: legacy web app, backend, RPA worker and n8n (Docker).
//   npm start                 everything, RPA headless
//   npm start -- --visible    RPA drives a visible browser (for the live demo)
//   npm start -- --no-n8n     run the same steps in-process, without n8n
//   npm start -- --reset      fresh database and legacy data
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAR = path.join(ROOT, "var");
const args = new Set(process.argv.slice(2));
const useN8n = !args.has("--no-n8n");
const visible = args.has("--visible");
const reset = args.has("--reset");

fs.mkdirSync(VAR, { recursive: true });
if (reset) {
  for (const f of fs.readdirSync(VAR)) if (/^(complaints\.db.*|legacy\.json)$/.test(f)) fs.rmSync(path.join(VAR, f));
}

const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const children = [];

function run(name, script, env) {
  const log = fs.openSync(path.join(VAR, `${name}.log`), "w");
  const child = spawn(process.execPath, ["--no-warnings", tsx, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.on("exit", (code) => code && process.stdout.write(`! ${name} exited with code ${code}, see var/${name}.log\n`));
  children.push({ name, pid: child.pid });
  return child;
}

async function waitFor(url, label, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write(`! ${label} did not come up at ${url}\n`);
  return false;
}

if (useN8n) {
  execSync(`node "${path.join(ROOT, "scripts", "n8n.mjs")}" up`, { stdio: "inherit" });
}

run("legacy", "legacy/server.ts", { LEGACY_RESET: reset ? "1" : "0" });
run("backend", "src/server.ts", { ORCHESTRATOR: useN8n ? "n8n" : "inprocess" });
await waitFor("http://localhost:4100/health", "backend");
await waitFor("http://localhost:4200/", "legacy");
run("rpa", "rpa/worker.ts", { RPA_VISIBLE: visible ? "1" : "0" });
fs.writeFileSync(path.join(VAR, "pids.json"), JSON.stringify(children));

process.stdout.write(`
Demo is up${useN8n ? "" : " (in-process orchestration, no n8n)"}:
  Demo page        http://localhost:4100/ui/
  Legacy system    http://localhost:4200/
${useN8n ? "  n8n canvas       http://localhost:5678/\n" : ""}  Logs             var/*.log
Stop with Ctrl+C or "npm run stop".
`);

const stop = () => {
  execSync(`node "${path.join(ROOT, "scripts", "stop.mjs")}" --keep-n8n`, { stdio: "inherit" });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
