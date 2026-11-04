#!/usr/bin/env node
// n8n in Docker: data in ./n8n-data, workflows imported from ./n8n/workflows and activated.
//   node scripts/n8n.mjs up | down | import
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "complaint-agent-n8n";
const IMAGE = process.env.N8N_IMAGE ?? "docker.n8n.io/n8nio/n8n:1.108.1";
const DATA = path.join(ROOT, "n8n-data");
const FLOWS = path.join(ROOT, "n8n", "workflows");
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts });
const exists = () => sh(`docker ps -a --filter name=^${NAME}$ --format {{.Status}}`).trim();

async function waitUp() {
  for (let i = 0; i < 90; i += 1) {
    try {
      if ((await fetch("http://localhost:5678/healthz")).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("n8n did not become healthy on :5678");
}

function importFlows() {
  sh(`docker exec ${NAME} n8n import:workflow --separate --input=/flows`, { stdio: "inherit" });
  for (const f of fs.readdirSync(FLOWS).filter((x) => x.endsWith(".json"))) {
    const { id } = JSON.parse(fs.readFileSync(path.join(FLOWS, f), "utf8"));
    sh(`docker exec ${NAME} n8n update:workflow --id=${id} --active=true`);
  }
  // Activation is read at start-up, so restart once after import.
  sh(`docker restart ${NAME}`);
}

const cmd = process.argv[2] ?? "up";
if (cmd === "down") {
  if (exists()) sh(`docker rm -f ${NAME}`);
  process.stdout.write("n8n stopped\n");
} else if (cmd === "up" || cmd === "import") {
  fs.mkdirSync(DATA, { recursive: true });
  if (!exists()) {
    sh(
      `docker run -d --name ${NAME} -p 5678:5678 --add-host=host.docker.internal:host-gateway ` +
        `-e N8N_SECURE_COOKIE=false -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_PERSONALIZATION_ENABLED=false ` +
        `-e N8N_RUNNERS_ENABLED=true -e GENERIC_TIMEZONE=Australia/Sydney -e WEBHOOK_URL=http://localhost:5678/ ` +
        `-e N8N_BLOCK_ENV_ACCESS_IN_NODE=false ` +
        `-v "${DATA}:/home/node/.n8n" -v "${FLOWS}:/flows:ro" ${IMAGE}`,
    );
  } else if (!exists().startsWith("Up")) {
    sh(`docker start ${NAME}`);
  }
  await waitUp();
  importFlows();
  await waitUp();
  process.stdout.write("n8n is up on http://localhost:5678 with workflows imported\n");
}
