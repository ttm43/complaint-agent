import type { Complaint, ComplaintState } from "./types";

// Legal transitions. HUMAN_HANDLING is reachable from every state (added below).
const TRANSITIONS: Readonly<Record<ComplaintState, readonly ComplaintState[]>> = {
  RECEIVED: ["IDENTIFIED", "UNVERIFIED"],
  IDENTIFIED: ["CLASSIFIED"],
  UNVERIFIED: [],
  CLASSIFIED: ["INVESTIGATING"],
  INVESTIGATING: ["PENDING_APPROVAL", "RESOLVING"],
  PENDING_APPROVAL: ["RESOLVING"],
  RESOLVING: ["PENDING_REVIEW"],
  PENDING_REVIEW: ["CLOSED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["INVESTIGATING"],
  HUMAN_HANDLING: ["CLOSED"],
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: ComplaintState, readonly to: ComplaintState) {
    super(`Illegal state transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: ComplaintState, to: ComplaintState): boolean {
  if (to === "HUMAN_HANDLING") return from !== "HUMAN_HANDLING" && from !== "CLOSED";
  return TRANSITIONS[from].includes(to);
}

/** Returns a new complaint in the target state; never mutates the input. */
export function transition(complaint: Complaint, to: ComplaintState, now: Date): Complaint {
  if (!canTransition(complaint.state, to)) throw new IllegalTransitionError(complaint.state, to);
  return { ...complaint, state: to, updatedAt: now.toISOString() };
}
