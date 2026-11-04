import path from "node:path";
import express, { type Express } from "express";
import { config, ROOT } from "./config";
import { createContext, type AppContext } from "./context";
import { CallEngine } from "./engine/callEngine";
import { InProcessOrchestrator, N8nOrchestrator, type Orchestrator } from "./engine/orchestrator";
import { internalRoutes } from "./http/internalRoutes";
import { publicRoutes } from "./http/publicRoutes";
import { errorHandler } from "./http/util";
import { seedHistoric } from "./seed";

export function createApp(ctx: AppContext, orch: Orchestrator): Express {
  const engine = new CallEngine(ctx, orch);
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/ui", express.static(path.join(ROOT, "public", "ui")));
  app.use("/audio", express.static(config.audioDir, { fallthrough: false }));
  app.get("/", (_req, res) => res.redirect("/ui/"));
  app.get("/health", (_req, res) => res.json({ ok: true, orchestrator: orch.name }));
  app.use(publicRoutes(ctx, engine, orch));
  app.use(internalRoutes(ctx, orch instanceof N8nOrchestrator ? orch : null));
  app.use(errorHandler);
  return app;
}

function main(): void {
  const ctx = createContext();
  seedHistoric(ctx);
  const orch: Orchestrator =
    config.orchestrator === "n8n" ? new N8nOrchestrator(ctx, config.n8nUrl, config.backendUrlForN8n) : new InProcessOrchestrator(ctx);
  createApp(ctx, orch).listen(config.port, () => {
    process.stdout.write(`[backend] http://localhost:${config.port}/ui/  (orchestrator: ${orch.name})\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, "src", "server.ts")) main();
