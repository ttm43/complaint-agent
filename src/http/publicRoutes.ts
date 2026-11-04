import { Router, type Response } from "express";
import { z } from "zod";
import type { AppContext } from "../context";
import type { CallEngine } from "../engine/callEngine";
import type { Orchestrator } from "../engine/orchestrator";
import { evaluate, sampleRate } from "../domain/review";
import { slaStatus } from "../domain/sla";
import { CATEGORIES } from "../domain/types";
import { runScenario, type RunResult } from "../scenarios/runner";
import { applyApproval, reopen, reviewClosure } from "../steps/resolution";
import type { AuditEvent } from "../store/events";
import { audioId, customerVoice } from "../phrases";
import { body, HttpError, ok, param, wrap } from "./util";

const StartSchema = z.object({ callId: z.string().min(1).max(64), scenarioId: z.string().max(16).nullable().default(null) });
const TurnSchema = z.object({
  text: z.string().max(2000).optional(),
  say: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  keypad: z.string().max(8).optional(),
});
const DecisionSchema = z.object({ approved: z.boolean(), by: z.string().min(1).max(40).default("reviewer") });
const ReopenSchema = z.object({ correctedCategory: z.enum(CATEGORIES).nullable().default(null), text: z.string().max(500).default("") });
const StatsSchema = z.object({
  reviewed: z.number().int().min(0).max(100000),
  misclassified: z.number().int().min(0),
  wrongCitation: z.number().int().min(0),
  mode: z.enum(["full", "sample"]),
});
const RunAllSchema = z.object({ scenarioIds: z.array(z.string().max(16)).min(1).max(9) });

export function publicRoutes(ctx: AppContext, engine: CallEngine, orch: Orchestrator): Router {
  const r = Router();

  r.get("/api/scenarios", (_req, res) => ok(res, ctx.data.scenarios.map((s) => ({
    ...s,
    turns: s.turns.map((t) => ({ ...t, audioId: t.keypad ? null : audioId(customerVoice(s.customer.name), t.say) })),
  }))));
  r.get("/api/info", (_req, res) => ok(res, { orchestrator: orch.name }));

  r.post("/complaints", wrap(async (req, res) => {
    const b = body(req, StartSchema);
    ok(res, await engine.start(b.callId, b.scenarioId), 201);
  }));

  r.post("/complaints/:id/turns", wrap(async (req, res) => {
    const id = param(req, "id");
    ctx.complaints.require(id);
    ok(res, { phase: await engine.turn(id, body(req, TurnSchema)) });
  }));

  r.get("/complaints", (_req, res) => ok(res, ctx.complaints.findAll().map((c) => ({ ...c, sla: slaStatus(c.receivedAt, new Date()) }))));
  r.get("/complaints/:id", (req, res) => {
    const c = ctx.complaints.findById(param(req, "id"));
    if (!c) throw new HttpError(404, "Complaint not found");
    ok(res, { ...c, sla: slaStatus(c.receivedAt, new Date()), retrieval: ctx.reviews.retrieval(c.id), tasks: ctx.tasks.forComplaint(c.id) });
  });
  r.get("/complaints/:id/events", (req, res) => ok(res, ctx.events.forComplaint(param(req, "id"))));

  r.post("/complaints/:id/reopen", (req, res) => {
    const b = body(req, ReopenSchema);
    const id = param(req, "id");
    const c = ctx.complaints.require(id);
    if (c.state !== "CLOSED") throw new HttpError(409, `Only a closed complaint can be reopened (state is ${c.state})`);
    ctx.events.append({ complaintId: id, actor: "customer", type: "feedback", summary: `Customer replied to the closure email: "${b.text}"`, detail: {} });
    reopen(ctx, id, b.correctedCategory, b.text);
    ok(res, ctx.complaints.require(id));
  });

  // Approvals go back through n8n (the Wait node resumes); closure reviews are handled here.
  r.post("/reviews/:taskId/decision", wrap(async (req, res) => {
    const b = body(req, DecisionSchema);
    const task = ctx.tasks.require(param(req, "taskId"));
    if (task.status !== "open") throw new HttpError(409, `Task already ${task.status}`);
    if (task.kind === "approval") {
      if (task.resumeUrl) {
        const resumed = await fetch(task.resumeUrl, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id, ...b }),
        });
        if (!resumed.ok) throw new HttpError(502, `n8n did not accept the resume call (${resumed.status})`);
      } else {
        await applyApproval(ctx, task.id, b.approved, b.by);
      }
    } else if (task.kind === "closure_review") {
      reviewClosure(ctx, task.id, b.approved, b.by);
    } else {
      ctx.tasks.resolve(task.id, "done");
      ctx.events.append({ complaintId: task.complaintId, actor: "human", type: "task_done", summary: `${b.by} picked up: ${task.summary}`, detail: {} });
    }
    ok(res, ctx.tasks.require(task.id));
  }));

  r.get("/api/tasks", (_req, res) => ok(res, ctx.tasks.open()));

  r.get("/api/review-stats", (_req, res) => ok(res, {
    target: ctx.settings.reviewTarget,
    sampleRate: ctx.sampleRate,
    categories: ctx.reviews.all().map((s) => ({ ...s, ...evaluate(s, ctx.settings.reviewTarget), configuredMode: s.mode, effectiveRate: sampleRate(s.mode, ctx.sampleRate) })),
  }));

  // Demo control: preset counts to show a category reaching the sampling threshold.
  r.post("/api/review-stats/:category", (req, res) => {
    const category = z.enum(CATEGORIES).parse(param(req, "category"));
    const b = body(req, StatsSchema);
    const eligible = evaluate({ category, ...b }, ctx.settings.reviewTarget).mode === "sample";
    if (b.mode === "sample" && !eligible) throw new HttpError(409, "Not enough evidence yet: the error upper bound is above target");
    ctx.reviews.save({ category, ...b });
    ok(res, ctx.reviews.get(category));
  });

  r.post("/api/demo/run-all", wrap(async (req, res) => {
    const { scenarioIds } = body(req, RunAllSchema);
    const results: RunResult[] = [];
    for (const id of scenarioIds) {
      const s = ctx.data.scenarios.find((x) => x.id === id);
      if (!s) throw new HttpError(400, `Unknown scenario ${id}`);
      results.push(await runScenario(ctx, engine, s, `BATCH-${id}-${Date.now()}`));
    }
    ok(res, results);
  }));

  r.get("/events/stream", (req, res) => sse(ctx, Number(req.query["since"] ?? 0), res));
  return r;
}

/** Server-sent events: replay from `since`, then push live. The page builds its timeline from this. */
function sse(ctx: AppContext, since: number, res: Response): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (e: AuditEvent) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  ctx.events.since(Number.isFinite(since) ? since : 0, 2000).forEach(send);
  const unsubscribe = ctx.events.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}
