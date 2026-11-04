import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context";
import type { N8nOrchestrator } from "../engine/orchestrator";
import { concludeInvestigation, lookUpClaim, retrieveBasis, verifyIdentity } from "../steps/investigation";
import { applyApproval, decideResolution, slaCheck } from "../steps/resolution";
import { handoff } from "../steps/common";
import { body, HttpError, ok, param, wrap } from "./util";

// Endpoints n8n calls (step logic), the RPA worker calls (jobs), and the mock source systems.

const Id = z.object({ complaintId: z.string().min(1).max(32) });
const IdentitySchema = Id.extend({ policyNumber: z.string().max(16), dob: z.string().max(16) });
const RetrieveSchema = Id.extend({ queryText: z.string().max(2000) });
const CompleteSchema = Id.extend({ rpaOk: z.boolean(), notes: z.array(z.string()).default([]), attempts: z.number().int().optional() });
const JobSchema = z.object({
  complaintId: z.string().max(32).nullable(),
  kind: z.enum(["read_claim_notes", "write_claim_note", "write_complaint"]),
  payload: z.record(z.string(), z.unknown()),
  callbackUrl: z.string().url().nullable().default(null),
  attempt: z.number().int().min(1).max(10).default(1),
  idempotencyKey: z.string().min(1).max(120),
});
const JobResultSchema = z.object({ ok: z.boolean(), result: z.record(z.string(), z.unknown()).default({}) });
const ResumeSchema = z.object({ resumeUrl: z.string().url() });
const ApplySchema = z.object({ approved: z.boolean(), by: z.string().max(40).default("reviewer") });
const CallEventSchema = Id.extend({ event: z.enum(["started", "ended"]), outcome: z.string().nullable().default(null) });

export function internalRoutes(ctx: AppContext, n8n: N8nOrchestrator | null): Router {
  const r = Router();

  // ----- steps (called by n8n) -----
  r.post("/internal/identity/verify", (req, res) => {
    const b = body(req, IdentitySchema);
    ok(res, verifyIdentity(ctx, b.complaintId, b.policyNumber, b.dob));
  });
  r.post("/internal/investigation/claim", (req, res) => ok(res, lookUpClaim(ctx, body(req, Id).complaintId)));
  r.post("/internal/investigation/retrieve", wrap(async (req, res) => {
    const b = body(req, RetrieveSchema);
    const out = await retrieveBasis(ctx, b.complaintId, b.queryText);
    ok(res, { hasBasis: out.hasBasis, mode: out.result.mode, chunks: out.result.chunks.map((c) => c.chunkId) });
  }));
  r.post("/internal/investigation/complete", (req, res) => {
    const b = body(req, CompleteSchema);
    const c = ctx.complaints.require(b.complaintId);
    const outcome = concludeInvestigation(ctx, b.complaintId, b.rpaOk, b.notes);
    if (!b.rpaOk) ctx.events.append({ complaintId: c.id, actor: "n8n", type: "n8n_retries_exhausted", summary: `n8n: RPA read failed ${b.attempts ?? ctx.settings.rpaAttempts} times, giving up`, detail: {} });
    if (!n8n?.stepDone(`investigation:${b.complaintId}`, outcome)) throw new HttpError(409, "No call is waiting for this investigation");
    ok(res, outcome);
  });
  r.post("/internal/resolution/decide", (req, res) => ok(res, decideResolution(ctx, body(req, Id).complaintId)));
  r.post("/internal/tasks/:id/resume-url", (req, res) => {
    const t = ctx.tasks.setResumeUrl(param(req, "id"), body(req, ResumeSchema).resumeUrl);
    ctx.events.append({ complaintId: t.complaintId, actor: "n8n", type: "n8n_waiting", summary: "n8n: workflow paused at Wait node until a person decides", detail: { taskId: t.id } });
    ok(res, t);
  });
  r.post("/internal/approvals/:taskId/apply", wrap(async (req, res) => {
    const b = body(req, ApplySchema);
    await applyApproval(ctx, param(req, "taskId"), b.approved, b.by);
    ok(res, { applied: true });
  }));
  r.post("/internal/human-task", (req, res) => {
    const b = body(req, Id.extend({ kind: z.enum(["rpa_failed", "handoff", "callback"]), reason: z.string().max(200) }));
    handoff(ctx, b.complaintId, { kind: b.kind, reason: b.reason });
    ok(res, { created: true });
  });
  // n8n narrates its own control flow (retries, back-off) onto the complaint timeline.
  r.post("/internal/n8n-log", (req, res) => {
    const b = body(req, Id.extend({ type: z.string().regex(/^n8n_[a-z_]+$/).max(40), summary: z.string().max(300) }));
    ok(res, ctx.events.append({ complaintId: b.complaintId, actor: "n8n", type: b.type, summary: `n8n: ${b.summary}`, detail: {} }));
  });
  r.post("/internal/sla/check",(_req, res) => ok(res, { flagged: slaCheck(ctx, new Date()) }));
  r.post("/internal/call-event", (req, res) => {
    const b = body(req, CallEventSchema);
    ctx.events.append({
      complaintId: b.complaintId, actor: "n8n", type: b.event === "ended" ? "notification" : "n8n_call",
      summary: b.event === "ended" ? `n8n: post-call notification queued (${b.outcome ?? "done"})` : "n8n: complaint-main started for this call",
      detail: { ...b },
    });
    ok(res, { logged: true });
  });

  // ----- RPA jobs -----
  r.post("/rpa/jobs", (req, res) => {
    const b = body(req, JobSchema);
    const job = ctx.rpa.submit(b);
    ok(res, { jobId: job.id, status: job.status }, 202);
  });
  r.get("/rpa/jobs/next", (_req, res) => ok(res, ctx.rpa.claimNext()));
  r.post("/rpa/jobs/:id/callback", wrap(async (req, res) => {
    const b = body(req, JobResultSchema);
    ok(res, await ctx.rpa.complete(param(req, "id"), b.ok, b.result));
  }));

  // ----- mock source systems (read-only APIs) -----
  r.get("/mock/policy/:policyNumber", (req, res) => {
    const p = ctx.data.policies.find((x) => x.policyNumber === param(req, "policyNumber"));
    if (!p) throw new HttpError(404, "Policy not found");
    ok(res, p);
  });
  r.get("/mock/claims", (req, res) => ok(res, ctx.data.claims.filter((c) => c.policyNumber === String(req.query["policy"] ?? ""))));
  return r;
}
