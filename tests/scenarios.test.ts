import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../src/context";
import { CallEngine } from "../src/engine/callEngine";
import { InProcessOrchestrator } from "../src/engine/orchestrator";
import { runScenario } from "../src/scenarios/runner";
import { applyApproval, reopen, reviewClosure } from "../src/steps/resolution";

// End-to-end through the engine with the in-process orchestrator and a fake RPA worker
// that behaves like the legacy system: CLM-FAIL always errors, everything else works.

let ctx: AppContext;
let engine: CallEngine;
let stopWorker: () => void;

function startFakeWorker(c: AppContext): () => void {
  let running = true;
  const loop = async () => {
    while (running) {
      const job = c.rpa.claimNext();
      if (!job) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      const failing = job.payload["claimId"] === "CLM-FAIL" && job.kind === "read_claim_notes";
      await c.rpa.complete(job.id, !failing, failing ? { error: "legacy system error 500" } : { verified: true, notes: ["note"] });
    }
  };
  void loop();
  return () => { running = false; };
}

beforeEach(() => {
  ctx = createContext({ dbPath: ":memory:", timing: { mixLatencyMs: 20, timeoutMs: 60 }, settings: { rpaTimeoutMs: 2000 } });
  engine = new CallEngine(ctx, new InProcessOrchestrator(ctx));
  stopWorker = startFakeWorker(ctx);
});
afterEach(() => stopWorker());

const scenario = (id: string) => {
  const s = ctx.data.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

describe("all nine scenarios reach their expected state", () => {
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]) {
    it(id, async () => {
      const r = await runScenario(ctx, engine, scenario(id), `CALL-${id}`);
      expect(r.finalState).toBe(r.expectedState);
    });
  }
});

describe("scenario details", () => {
  it("is idempotent on callId", async () => {
    const a = await engine.start("CALL-dup", "s1");
    const b = await engine.start("CALL-dup", "s1");
    expect(b.complaintId).toBe(a.complaintId);
    expect(b.created).toBe(false);
    expect(ctx.complaints.findAll()).toHaveLength(1);
  });

  it("s2 goes to keypad after two rejected read-backs and never discloses policy data", async () => {
    const r = await runScenario(ctx, engine, scenario("s2"), "CALL-s2b");
    const events = ctx.events.forComplaint(r.complaintId);
    expect(events.filter((e) => e.type === "readback_denied")).toHaveLength(2);
    expect(events.some((e) => e.detail["phraseId"] === "ASK_KEYPAD")).toBe(true);
    expect(events.some((e) => e.type === "claims_api" || e.type === "retrieval")).toBe(false);
    // Nothing from the policy may reach the log: holder name, vehicle, the real date of birth.
    const leaked = events.filter((e) => e.actor !== "customer").map((e) => JSON.stringify(e)).join(" ");
    expect(leaked).not.toMatch(/Priya Sharma|Mazda|1990-04-12|Grace Kim/);
    expect(events.some((e) => e.detail["to"] === "UNVERIFIED")).toBe(true);
  });

  it("s4 hands off with high priority", async () => {
    const r = await runScenario(ctx, engine, scenario("s4"), "CALL-s4b");
    expect(ctx.complaints.require(r.complaintId).priority).toBe("high");
  });

  it("s5 retries the RPA read three times, then creates a human task", async () => {
    const r = await runScenario(ctx, engine, scenario("s5"), "CALL-s5b");
    const fails = ctx.events.forComplaint(r.complaintId).filter((e) => e.type === "rpa_failed");
    expect(fails).toHaveLength(3);
    expect(ctx.tasks.forComplaint(r.complaintId).some((t) => t.kind === "rpa_failed")).toBe(true);
  });

  it("s7 cites the 2024 PDS and continues after approval", async () => {
    const r = await runScenario(ctx, engine, scenario("s7"), "CALL-s7b");
    const retrieval = ctx.reviews.retrieval(r.complaintId);
    expect(retrieval?.mode).toBe("mix");
    expect(retrieval?.chunks.some((c) => c.chunkId === "PDS24-7.3")).toBe(true);
    expect(retrieval?.chunks.some((c) => c.chunkId.startsWith("PDS26"))).toBe(false);
    const task = ctx.tasks.forComplaint(r.complaintId).find((t) => t.kind === "approval");
    if (!task) throw new Error("no approval task");
    await applyApproval(ctx, task.id, true, "test");
    expect(ctx.complaints.require(r.complaintId).state).toBe("PENDING_REVIEW");
  });

  it("s8 closes, reopens with the same received time and counts a misclassification", async () => {
    const r = await runScenario(ctx, engine, scenario("s8"), "CALL-s8b");
    const before = ctx.complaints.require(r.complaintId);
    const review = ctx.tasks.forComplaint(r.complaintId).find((t) => t.kind === "closure_review");
    if (!review) throw new Error("no review task");
    reviewClosure(ctx, review.id, true, "test");
    expect(ctx.complaints.require(r.complaintId).state).toBe("CLOSED");
    reopen(ctx, r.complaintId, "repair_quality", "It's not fixed at all.");
    const after = ctx.complaints.require(r.complaintId);
    expect(after.state).toBe("REOPENED");
    expect(after.receivedAt).toBe(before.receivedAt);
    const stats = ctx.reviews.get("claim_delay");
    expect(stats.misclassified).toBe(1);
    expect(stats.mode).toBe("full");
    expect(ctx.reviews.trainingExamples()[0]?.corrected).toBe("repair_quality");
  });

  it("s9 plays the second hold line, degrades, and hands off", async () => {
    const slow = createContext({ dbPath: ":memory:", timing: { mixLatencyMs: 20, timeoutMs: 4200 } });
    const stop = startFakeWorker(slow);
    try {
      const e = new CallEngine(slow, new InProcessOrchestrator(slow));
      const s = slow.data.scenarios.find((x) => x.id === "s9");
      if (!s) throw new Error("s9");
      const r = await runScenario(slow, e, s, "CALL-s9b");
      const events = slow.events.forComplaint(r.complaintId);
      expect(events.some((x) => x.type === "retrieval_degraded")).toBe(true);
      expect(events.filter((x) => x.detail["phraseId"] === "HOLD_2")).toHaveLength(1);
      expect(r.finalState).toBe("HUMAN_HANDLING");
    } finally {
      stop();
    }
  }, 15000);

  it("rejects an action whose citation was not retrieved", async () => {
    const { decide } = await import("../src/domain/whitelist");
    const d = decide({ type: "explain_reason", citations: ["PDS24-99"] }, { category: "claim_delay", retrieved: [], pdsVersion: "2026" });
    expect(d.route).toBe("human");
  });
});
