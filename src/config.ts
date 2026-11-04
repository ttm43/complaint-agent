import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  port: intEnv("PORT", 4100),
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:4100",
  /** How n8n (inside Docker) reaches this backend. */
  backendUrlForN8n: process.env.BACKEND_URL_FOR_N8N ?? "http://host.docker.internal:4100",
  legacyUrl: process.env.LEGACY_URL ?? "http://localhost:4200",
  n8nUrl: process.env.N8N_URL ?? "http://localhost:5678",
  /** "n8n" sends each step through n8n; "inprocess" runs the same steps in this process. */
  orchestrator: (process.env.ORCHESTRATOR ?? "n8n") as "n8n" | "inprocess",
  dbPath: process.env.DB_PATH ?? path.join(ROOT, "var", "complaints.db"),
  dataDir: path.join(ROOT, "data"),
  scenarioFile: path.join(ROOT, "scenarios", "scenarios.json"),
  audioDir: path.join(ROOT, "public", "audio"),

  classifierThreshold: 0.6,
  retrievalMinScore: 0.3,
  retrievalMixLatencyMs: intEnv("MIX_LATENCY_MS", 2500),
  retrievalTimeoutMs: intEnv("RETRIEVAL_TIMEOUT_MS", 5000),
  rpaAttempts: 3,
  rpaTimeoutMs: intEnv("RPA_TIMEOUT_MS", 15000),
  reviewTarget: 0.01,
  sampleRateDefault: 0.1,
  stepTimeoutMs: intEnv("STEP_TIMEOUT_MS", 60000),
} as const;
