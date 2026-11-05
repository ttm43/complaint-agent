import { config } from "../config";
import type { AppContext } from "../context";
import type { CallEngine } from "../engine/callEngine";
import { seedHistoric } from "../seed";

/** Raised when clearing would pull data out from under a live call or a running robot job. */
export class DemoBusyError extends Error {}

export interface ClearResult {
  readonly complaints: number;
  readonly tasks: number;
}

// Tables that only hold what demo runs wrote. review_stats is reset, not emptied.
const DEMO_TABLES = ["events", "tasks", "rpa_jobs", "retrievals", "training_examples", "complaints"] as const;

const count = (ctx: AppContext, sql: string): number => (ctx.db.prepare(sql).get() as { n: number }).n;

/**
 * Back to the state of a fresh start, without restarting: seeded history stays,
 * review counts go back to zero and full review. Event sequence numbers keep counting,
 * so pages already listening to the stream are not confused.
 */
export function clearDemoData(ctx: AppContext, engine: CallEngine): ClearResult {
  if (engine.hasActiveCall()) throw new DemoBusyError("A call is still in progress; wait for it to end.");
  if (count(ctx, "SELECT COUNT(*) AS n FROM rpa_jobs WHERE status IN ('queued', 'running')") > 0) {
    throw new DemoBusyError("The robot is still working on a job; try again in a moment.");
  }

  const before: ClearResult = {
    complaints: count(ctx, "SELECT COUNT(*) AS n FROM complaints WHERE call_id NOT LIKE 'HIST-%'"),
    tasks: count(ctx, "SELECT COUNT(*) AS n FROM tasks"),
  };

  ctx.db.exec("BEGIN");
  try {
    for (const table of DEMO_TABLES) ctx.db.exec(`DELETE FROM ${table}`);
    ctx.db.exec("UPDATE review_stats SET reviewed = 0, misclassified = 0, wrong_citation = 0, mode = 'full'");
    ctx.db.exec("COMMIT");
  } catch (err: unknown) {
    ctx.db.exec("ROLLBACK");
    throw err;
  }

  engine.forgetEndedCalls();
  ctx.sampleRate = config.sampleRateDefault;
  seedHistoric(ctx);
  ctx.events.append({
    complaintId: null, actor: "system", type: "demo_cleared",
    summary: `Demo data cleared: ${before.complaints} complaint(s), ${before.tasks} task(s)`, detail: { ...before },
  });
  return before;
}
