import { describe, expect, it } from "vitest";
import { canTransition, IllegalTransitionError, transition } from "../src/domain/stateMachine";
import type { Complaint } from "../src/domain/types";

const base: Complaint = {
  id: "C-1",
  callId: "CALL-1",
  state: "RECEIVED",
  receivedAt: "2026-11-01T00:00:00.000Z",
  policyNumber: null,
  claimId: null,
  pdsVersion: null,
  category: null,
  categoryConfidence: null,
  priority: "normal",
  scenarioId: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

describe("state machine", () => {
  it("walks the happy path", () => {
    const path = ["IDENTIFIED", "CLASSIFIED", "INVESTIGATING", "RESOLVING", "PENDING_REVIEW", "CLOSED", "REOPENED"] as const;
    let c = base;
    for (const s of path) c = transition(c, s, new Date());
    expect(c.state).toBe("REOPENED");
  });

  it("does not mutate the input", () => {
    const next = transition(base, "IDENTIFIED", new Date("2026-11-02T00:00:00Z"));
    expect(base.state).toBe("RECEIVED");
    expect(next.updatedAt).toBe("2026-11-02T00:00:00.000Z");
  });

  it("keeps receivedAt on reopen", () => {
    const closed = { ...base, state: "CLOSED" as const };
    expect(transition(closed, "REOPENED", new Date()).receivedAt).toBe(base.receivedAt);
  });

  it("allows HUMAN_HANDLING from any open state", () => {
    for (const s of ["RECEIVED", "UNVERIFIED", "INVESTIGATING", "PENDING_REVIEW", "REOPENED"] as const) {
      expect(canTransition(s, "HUMAN_HANDLING")).toBe(true);
    }
    expect(canTransition("CLOSED", "HUMAN_HANDLING")).toBe(false);
  });

  it("rejects skipping steps", () => {
    expect(() => transition(base, "CLOSED", new Date())).toThrow(IllegalTransitionError);
    expect(canTransition("UNVERIFIED", "CLASSIFIED")).toBe(false);
  });
});
