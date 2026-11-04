import type { AppContext } from "../context";
import { evaluate, recordSilentError } from "../domain/review";
import { slaStatus } from "../domain/sla";
import type { ActionRequest, Category } from "../domain/types";
import { decide, type Route } from "../domain/whitelist";
import { handoff, moveTo } from "./common";

export interface ResolutionDecision {
  readonly route: Route;
  readonly reason: string;
  readonly reply: string;
  readonly action: ActionRequest | null;
}

/** Ask the LLM for a resolution, then let the backend decide whether it may go ahead. */
export function decideResolution(ctx: AppContext, complaintId: string): ResolutionDecision {
  const c = ctx.complaints.require(complaintId);
  if (!c.category) throw new Error(`Complaint ${complaintId} is not classified`);
  const retrieved = ctx.reviews.retrieval(complaintId)?.chunks ?? [];
  const { reply, action } = ctx.llm.resolve({ scenarioId: c.scenarioId, category: c.category, retrieved });

  if (!action) {
    const reason = "the model proposed no action";
    ctx.events.append({ complaintId, actor: "agent", type: "decision", summary: `No action proposed -> human`, detail: { route: "human" } });
    return { route: "human", reason, reply, action: null };
  }

  const d = decide(action, { category: c.category, retrieved, pdsVersion: c.pdsVersion });
  ctx.events.append({
    complaintId, actor: "agent", type: "action_requested",
    summary: `Agent requests ${action.type}, citing ${action.citations.join(", ") || "nothing"}`,
    detail: { action },
  });
  ctx.events.append({
    complaintId, actor: "system", type: "decision",
    summary: `Whitelist: ${action.type} -> ${d.route} (${d.reason})`,
    detail: { route: d.route, reason: d.reason, citationProblems: d.citationProblems, citations: action.citations },
  });
  return { route: d.route, reason: d.reason, reply, action };
}

/** Write the agreed action to the legacy claims system through RPA. */
export async function executeAction(ctx: AppContext, complaintId: string, action: ActionRequest): Promise<boolean> {
  const c = ctx.complaints.require(complaintId);
  const out = await ctx.rpa.run(
    {
      idempotencyKey: `${complaintId}:${action.type}`,
      complaintId,
      kind: "write_claim_note",
      payload: { claimId: c.claimId, text: `[${complaintId}] ${action.type}: requested by complaints agent. Basis: ${action.citations.join(", ")}` },
      attempt: 1,
    },
    ctx.settings.rpaTimeoutMs,
  );
  return out.ok;
}

/** Register the complaint in the complaint system of record (legacy, RPA only). */
export async function registerComplaint(ctx: AppContext, complaintId: string, outcome: string, summary: string): Promise<boolean> {
  const c = ctx.complaints.require(complaintId);
  const out = await ctx.rpa.run(
    {
      idempotencyKey: `${complaintId}:register:${outcome}`,
      complaintId,
      kind: "write_complaint",
      payload: {
        ref: complaintId,
        // pdsVersion is only set once identity is verified; an unverified caller's claimed number is not recorded.
        policyNumber: c.pdsVersion === null || c.policyNumber === null ? "UNVERIFIED" : c.policyNumber,
        category: c.category ?? "unclassified",
        receivedAt: c.receivedAt,
        status: outcome,
        summary,
      },
      attempt: 1,
    },
    ctx.settings.rpaTimeoutMs,
  );
  if (!out.ok) handoff(ctx, complaintId, { kind: "rpa_failed", reason: "could not write to the complaint system; register by hand" });
  return out.ok;
}

export function proposeClosure(ctx: AppContext, complaintId: string, resolutionText: string): void {
  moveTo(ctx, complaintId, "PENDING_REVIEW", "customer accepted; closure proposed for review");
  const c = ctx.complaints.require(complaintId);
  const stats = c.category ? ctx.reviews.get(c.category) : null;
  ctx.tasks.create({
    complaintId, kind: "closure_review", priority: c.priority,
    summary: `Review closure (${stats?.mode === "sample" ? "sampled" : "full review"})`,
    detail: { resolutionText }, resumeUrl: null,
  });
}

export function requestApproval(ctx: AppContext, complaintId: string, action: ActionRequest, reason: string): string {
  moveTo(ctx, complaintId, "PENDING_APPROVAL", reason);
  const c = ctx.complaints.require(complaintId);
  const task = ctx.tasks.create({
    complaintId, kind: "approval", priority: c.priority,
    summary: `Approve ${action.type}: ${String(action.params?.["suggestion"] ?? "")}`.trim(),
    detail: { action }, resumeUrl: null,
  });
  return task.id;
}

/** A person approved or rejected an action the agent may not take on its own. */
export async function applyApproval(ctx: AppContext, taskId: string, approved: boolean, by: string): Promise<void> {
  const task = ctx.tasks.resolve(taskId, approved ? "approved" : "rejected");
  const action = task.detail["action"] as ActionRequest;
  ctx.events.append({
    complaintId: task.complaintId, actor: "human", type: "approval",
    summary: `${by} ${approved ? "approved" : "rejected"} ${action.type}`, detail: { taskId, approved },
  });
  if (!approved) {
    handoff(ctx, task.complaintId, { kind: "handoff", reason: "approval rejected; specialist to contact customer" });
    return;
  }
  moveTo(ctx, task.complaintId, "RESOLVING", "approved by a person");
  if (await executeAction(ctx, task.complaintId, action)) {
    await registerComplaint(ctx, task.complaintId, "approved_action", `${action.type} approved`);
    proposeClosure(ctx, task.complaintId, `${action.type} approved by ${by}`);
  } else {
    handoff(ctx, task.complaintId, { kind: "rpa_failed", reason: "approved action could not be written to the claims system" });
  }
}

export function reviewClosure(ctx: AppContext, taskId: string, approved: boolean, by: string): void {
  const task = ctx.tasks.resolve(taskId, approved ? "approved" : "rejected");
  const c = ctx.complaints.require(task.complaintId);
  if (!approved) {
    ctx.events.append({ complaintId: c.id, actor: "human", type: "review", summary: `${by} rejected the closure`, detail: {} });
    handoff(ctx, c.id, { kind: "handoff", reason: "closure rejected at review" });
    return;
  }
  if (c.category) {
    const s = ctx.reviews.get(c.category);
    ctx.reviews.save({ ...s, reviewed: s.reviewed + 1 });
  }
  ctx.events.append({ complaintId: c.id, actor: "human", type: "review", summary: `${by} approved the closure`, detail: {} });
  moveTo(ctx, c.id, "CLOSED", "closure approved at review");
  ctx.events.append({
    complaintId: c.id, actor: "system", type: "notification",
    summary: "Closure email sent with \"Did this solve your problem?\" feedback link",
    detail: { channel: "email", feedbackUrl: `/feedback/${c.id}` },
  });
}

/**
 * Customer says it was not solved. The complaint reopens with its original received
 * time, the error is counted against the category, and the category returns to full review.
 */
export function reopen(ctx: AppContext, complaintId: string, correctedCategory: Category | null, customerText: string): void {
  const c = ctx.complaints.require(complaintId);
  if (!c.category) throw new Error(`Complaint ${complaintId} has no category`);
  moveTo(ctx, complaintId, "REOPENED", "customer replied that the problem is not solved");
  const kind = correctedCategory && correctedCategory !== c.category ? "misclassified" : "wrongCitation";
  const before = ctx.reviews.get(c.category);
  const after = recordSilentError(before, { kind });
  ctx.reviews.save(after);
  if (kind === "misclassified" && correctedCategory) {
    const text = String(ctx.events.forComplaint(complaintId).find((e) => e.type === "classified")?.detail["text"] ?? "");
    ctx.reviews.addTrainingExample(complaintId, text, c.category, correctedCategory);
  }
  ctx.events.append({
    complaintId, actor: "system", type: "silent_error",
    summary: `Silent error (${kind}) on ${c.category}${correctedCategory ? ` -> corrected to ${correctedCategory}` : ""}. ` +
      `Category back to full review; received time unchanged (${c.receivedAt}).`,
    detail: { kind, customerText, before, after, upperBound: evaluate(after, ctx.settings.reviewTarget).upperBound },
  });
  // State stays REOPENED (that is what the page shows); a specialist picks it up from the queue.
  const task = ctx.tasks.create({
    complaintId, kind: "callback", priority: c.priority, summary: "Reopened complaint: specialist to call back",
    detail: { reopened: true }, resumeUrl: null,
  });
  ctx.events.append({ complaintId, actor: "system", type: "human_task", summary: "Human task (callback): reopened complaint", detail: { taskId: task.id } });
}

/** Scheduled by n8n: flag open complaints close to the 30-day limit. */
export function slaCheck(ctx: AppContext, now: Date): number {
  let flagged = 0;
  for (const c of ctx.complaints.findAll()) {
    if (c.state === "CLOSED") continue;
    const s = slaStatus(c.receivedAt, now);
    if (s.level === "ok") continue;
    const already = ctx.tasks.forComplaint(c.id).some((t) => t.kind === "sla" && t.detail["level"] === s.level);
    if (already) continue;
    ctx.tasks.create({
      complaintId: c.id, kind: "sla", priority: s.level === "warn_owner" ? "normal" : "high",
      summary: `${s.daysLeft} days left before the 30-day deadline (${s.level === "warn_owner" ? "remind owner" : "escalate to supervisor"})`,
      detail: { level: s.level, deadline: s.deadline }, resumeUrl: null,
    });
    ctx.events.append({ complaintId: c.id, actor: "n8n", type: "sla", summary: `SLA ${s.level}: ${s.daysLeft} days left`, detail: { ...s } });
    flagged += 1;
  }
  return flagged;
}
