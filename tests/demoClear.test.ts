import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../src/context";
import { CallEngine } from "../src/engine/callEngine";
import { InProcessOrchestrator } from "../src/engine/orchestrator";
import { runScenario } from "../src/scenarios/runner";
import { seedHistoric } from "../src/seed";
import { clearDemoData, DemoBusyError } from "../src/steps/demo";

let ctx: AppContext;
let engine: CallEngine;
let running = true;

function startFakeWorker(c: AppContext): void {
  running = true;
  const loop = async () => {
    while (running) {
      const job = c.rpa.claimNext();
      if (!job) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      await c.rpa.complete(job.id, true, { verified: true, notes: ["note"] });
    }
  };
  void loop();
}

const scenario = (id: string) => {
  const s = ctx.data.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

beforeEach(() => {
  ctx = createContext({ dbPath: ":memory:", timing: { mixLatencyMs: 20, timeoutMs: 60 }, settings: { rpaTimeoutMs: 2000 } });
  seedHistoric(ctx);
  engine = new CallEngine(ctx, new InProcessOrchestrator(ctx));
  startFakeWorker(ctx);
});
afterEach(() => { running = false; });

describe("clear demo data", () => {
  it("removes everything demo runs added and keeps the seeded history", async () => {
    await runScenario(ctx, engine, scenario("s7"), "CALL-S7");
    await runScenario(ctx, engine, scenario("s1"), "CALL-S1");
    ctx.reviews.save({ category: "claim_delay", reviewed: 300, misclassified: 0, wrongCitation: 0, mode: "sample" });
    ctx.sampleRate = 0.5;
    expect(ctx.tasks.open().length).toBeGreaterThan(0);

    const cleared = clearDemoData(ctx, engine);

    expect(cleared.complaints).toBe(2);
    expect(ctx.complaints.findAll().map((c) => c.id).sort()).toEqual(["CMP-HIST-0904", "CMP-HIST-0926"]);
    expect(ctx.tasks.open()).toEqual([]);
    const leftover = (table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(["rpa_jobs", "retrievals", "training_examples"].map(leftover)).toEqual([0, 0, 0]);
    expect(ctx.reviews.all().every((s) => s.reviewed === 0 && s.misclassified === 0 && s.wrongCitation === 0 && s.mode === "full")).toBe(true);
    expect(ctx.sampleRate).toBe(0.1);
    expect(ctx.events.since(0).map((e) => e.type)).toEqual(["demo_cleared"]);
  });

  it("lets the same call id start again after clearing", async () => {
    await runScenario(ctx, engine, scenario("s1"), "CALL-AGAIN");
    clearDemoData(ctx, engine);
    const again = await engine.start("CALL-AGAIN", "s1");
    expect(again.created).toBe(true);
  });

  it("refuses while a call is still in progress", async () => {
    await engine.start("CALL-LIVE", "s1");
    expect(() => clearDemoData(ctx, engine)).toThrow(DemoBusyError);
    expect(ctx.complaints.findAll().some((c) => c.callId === "CALL-LIVE")).toBe(true);
  });
});
