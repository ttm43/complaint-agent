import type { AppContext } from "../context";
import { transition } from "../domain/stateMachine";
import type { Complaint, ComplaintState, Priority } from "../domain/types";
import type { TaskKind } from "../store/work";

/** Move a complaint to a new state and write the transition to the audit log. */
export function moveTo(ctx: AppContext, complaintId: string, to: ComplaintState, why: string, patch: Partial<Complaint> = {}): Complaint {
  const current = ctx.complaints.require(complaintId);
  const next = transition({ ...current, ...patch }, to, new Date());
  const saved = ctx.complaints.save(next);
  ctx.events.append({
    complaintId,
    actor: "system",
    type: "state_changed",
    summary: `${current.state} -> ${to}: ${why}`,
    detail: { from: current.state, to, why },
  });
  return saved;
}

/** Update fields without a state change (e.g. priority, claim id). */
export function patch(ctx: AppContext, complaintId: string, fields: Partial<Complaint>): Complaint {
  const current = ctx.complaints.require(complaintId);
  return ctx.complaints.save({ ...current, ...fields, updatedAt: new Date().toISOString() });
}

export interface HandoffInput {
  readonly kind: TaskKind;
  readonly priority?: Priority;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
}

/** Any path that ends with a person: the complaint is already logged, a task goes on the queue. */
export function handoff(ctx: AppContext, complaintId: string, h: HandoffInput): void {
  const c = ctx.complaints.require(complaintId);
  const priority = h.priority ?? c.priority;
  if (c.state !== "HUMAN_HANDLING") moveTo(ctx, complaintId, "HUMAN_HANDLING", h.reason, { priority });
  const task = ctx.tasks.create({ complaintId, kind: h.kind, priority, summary: h.reason, detail: h.detail ?? {}, resumeUrl: null });
  ctx.events.append({
    complaintId, actor: "system", type: "human_task",
    summary: `Human task (${h.kind}${priority === "high" ? ", HIGH priority" : ""}): ${h.reason}`,
    detail: { taskId: task.id, kind: h.kind, priority },
  });
}
