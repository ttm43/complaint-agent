import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCitations } from "../src/domain/citations";
import { decide } from "../src/domain/whitelist";
import { slaStatus } from "../src/domain/sla";
import { startHold } from "../src/domain/hold";
import { isAffirmative, isValidDob, parseKeypad, parsePolicyNumber, readBack } from "../src/domain/identity";
import { errorUpperBound, evaluate, recordSilentError, sampleRate } from "../src/domain/review";
import type { RetrievedChunk } from "../src/domain/types";

const chunk = (chunkId: string, docId: string, docVersion: string): RetrievedChunk => ({
  chunkId, docId, docVersion, clause: "1", title: "t", text: "x", score: 0.9,
});
const retrieved = [chunk("PDS24-7.3", "PDS", "2024"), chunk("PDS26-7.3", "PDS", "2026"), chunk("COP-7.1", "COP", "current")];

describe("citations", () => {
  it("accepts chunks that were retrieved and match the policy's PDS version", () => {
    expect(checkCitations(["PDS24-7.3", "COP-7.1"], retrieved, "2024").ok).toBe(true);
  });
  it("rejects a PDS chunk from another version", () => {
    const r = checkCitations(["PDS26-7.3"], retrieved, "2024");
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("policy uses PDS 2024");
  });
  it("rejects invented chunks and empty citations", () => {
    expect(checkCitations(["PDS24-9.9"], retrieved, "2024").ok).toBe(false);
    expect(checkCitations([], retrieved, "2024").ok).toBe(false);
  });
});

describe("whitelist", () => {
  const ctx = { category: "claim_delay" as const, retrieved, pdsVersion: "2024" };
  it("executes a whitelisted action with a verified basis", () => {
    expect(decide({ type: "expedite_assessment", citations: ["COP-7.1"] }, ctx).route).toBe("execute");
  });
  it("sends money and decision changes to approval", () => {
    expect(decide({ type: "adjust_payout", citations: ["COP-7.1"] }, ctx).route).toBe("approval");
    expect(decide({ type: "reassess_decision", citations: ["PDS24-7.3"] }, ctx).route).toBe("approval");
  });
  it("hands off when the explanation has no verified basis, even for approval actions", () => {
    expect(decide({ type: "expedite_assessment", citations: [] }, ctx).route).toBe("human");
    expect(decide({ type: "adjust_payout", citations: ["PDS26-7.3"] }, ctx).route).toBe("human");
  });
  it("hands off actions outside the category's whitelist", () => {
    expect(decide({ type: "expedite_assessment", citations: ["COP-7.1"] }, { ...ctx, category: "claim_denial" }).route).toBe("human");
  });
  it("lets simple actions through without citations", () => {
    expect(decide({ type: "update_contact", citations: [] }, ctx).route).toBe("execute");
  });
});

describe("sla", () => {
  const received = "2026-10-01T00:00:00.000Z";
  it("computes a 30-day deadline", () => {
    expect(slaStatus(received, new Date("2026-10-02T00:00:00Z")).deadline).toBe("2026-10-31T00:00:00.000Z");
  });
  it("warns the owner, then the supervisor, then flags overdue", () => {
    expect(slaStatus(received, new Date("2026-10-10T00:00:00Z")).level).toBe("ok");
    expect(slaStatus(received, new Date("2026-10-27T00:00:00Z")).level).toBe("warn_owner");
    expect(slaStatus(received, new Date("2026-10-29T12:00:00Z")).level).toBe("escalate_supervisor");
    expect(slaStatus(received, new Date("2026-11-01T00:00:00Z")).level).toBe("overdue");
  });
});

describe("hold lines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays HOLD_1 at once and HOLD_2 after 4 s", () => {
    const said: string[] = [];
    const h = startHold((p) => said.push(p), () => said.push("GIVE_UP"));
    expect(said).toEqual(["HOLD_1"]);
    vi.advanceTimersByTime(4000);
    expect(said).toEqual(["HOLD_1", "HOLD_2"]);
    h.stop();
    vi.advanceTimersByTime(60000);
    expect(said).toEqual(["HOLD_1", "HOLD_2"]);
  });

  it("gives up at 30 s", () => {
    const said: string[] = [];
    startHold((p) => said.push(p), () => said.push("GIVE_UP"));
    vi.advanceTimersByTime(30000);
    expect(said).toEqual(["HOLD_1", "HOLD_2", "HOLD_3", "HOLD_3", "HOLD_3", "GIVE_UP"]);
  });
});

describe("identity", () => {
  it("parses policy numbers in the forms ASR produces", () => {
    expect(parsePolicyNumber("my policy number is POL1002")).toBe("POL-1002");
    expect(parsePolicyNumber("It's P O L one zero zero two.")).toBe("POL-1002");
    expect(parsePolicyNumber("Pol one zero zero two")).toBe("POL-1002");
    expect(parsePolicyNumber("POL 10")).toBeNull();
    expect(parsePolicyNumber("I don't know it")).toBeNull();
  });
  it("reads back digit by digit", () => {
    expect(readBack("POL-1002")).toBe("P O L one zero zero two");
  });
  it("validates keypad and dates", () => {
    expect(parseKeypad("1002")).toBe("POL-1002");
    expect(parseKeypad("10a2")).toBeNull();
    const now = new Date("2026-11-02T00:00:00Z");
    expect(isValidDob("1990-04-12", now)).toBe(true);
    expect(isValidDob("1990-02-30", now)).toBe(false);
    expect(isValidDob("2030-01-01", now)).toBe(false);
  });
  it("reads yes and no", () => {
    expect(isAffirmative("Yes, that's right.")).toBe(true);
    expect(isAffirmative("No, it's one zero zero two.")).toBe(false);
    expect(isAffirmative("I suppose so.")).toBe(true);
  });
});

describe("review", () => {
  it("uses the rule of three without errors", () => {
    expect(errorUpperBound(300, 0)).toBeCloseTo(0.01);
  });
  it("uses Wilson with errors", () => {
    const ub = errorUpperBound(100, 1);
    expect(ub).toBeGreaterThan(0.01);
    expect(ub).toBeLessThan(0.06);
  });
  it("moves to sampling only below target, and back to full on a silent error", () => {
    const stats = { category: "claim_delay" as const, reviewed: 400, misclassified: 0, wrongCitation: 0, mode: "sample" as const };
    expect(evaluate(stats, 0.01).mode).toBe("sample");
    const after = recordSilentError(stats, { kind: "misclassified" });
    expect(after.misclassified).toBe(1);
    expect(after.mode).toBe("full");
    expect(stats.misclassified).toBe(0);
  });
  it("never samples at zero", () => {
    expect(sampleRate("sample", 0)).toBe(0.05);
    expect(sampleRate("full", 0.1)).toBe(1);
  });
});
