import type { EventLog } from "../store/events";
import type { NewRpaJob, RpaJob, RpaJobRepository } from "../store/work";
import { Waiters } from "./waiters";

export interface RpaOutcome {
  readonly ok: boolean;
  readonly result: Readonly<Record<string, unknown>>;
}

/**
 * The backend side of RPA. Jobs are queued here, the Playwright worker pulls them,
 * runs them against the legacy web app and posts the result back. A result is then
 * forwarded to whoever is waiting: an n8n Wait node (callbackUrl) or this process.
 */
export class RpaBroker {
  private readonly waiters = new Waiters<RpaOutcome>();

  constructor(private readonly jobs: RpaJobRepository, private readonly events: EventLog) {}

  submit(j: NewRpaJob): RpaJob {
    const { job, duplicate } = this.jobs.submit(j);
    this.events.append({
      complaintId: j.complaintId,
      actor: "rpa",
      type: duplicate ? "rpa_duplicate" : "rpa_submitted",
      summary: duplicate
        ? `RPA ${j.kind}: already done under the same idempotency key, not repeated`
        : `RPA ${j.kind} queued (attempt ${j.attempt})`,
      detail: { jobId: job.id, kind: j.kind, attempt: j.attempt, idempotencyKey: j.idempotencyKey },
    });
    return job;
  }

  /** Submit and wait in this process (used for writes, and for reads in in-process mode). */
  async run(j: Omit<NewRpaJob, "callbackUrl">, timeoutMs: number): Promise<RpaOutcome> {
    const job = this.submit({ ...j, callbackUrl: null });
    if (job.status === "succeeded") return { ok: true, result: job.result ?? {} };
    return this.waiters.wait(job.id, timeoutMs, () => {
      this.events.append({
        complaintId: j.complaintId, actor: "rpa", type: "rpa_timeout",
        summary: `RPA ${j.kind} timed out after ${timeoutMs} ms`, detail: { jobId: job.id },
      });
      return { ok: false, result: { error: "timeout" } };
    });
  }

  claimNext(): RpaJob | null {
    return this.jobs.claimNext();
  }

  /** Called by the worker. Forwards to n8n when the job came from an n8n Wait node. */
  async complete(jobId: string, ok: boolean, result: Record<string, unknown>): Promise<RpaJob> {
    const job = this.jobs.finish(jobId, ok ? "succeeded" : "failed", result);
    this.events.append({
      complaintId: job.complaintId,
      actor: "rpa",
      type: ok ? "rpa_succeeded" : "rpa_failed",
      summary: ok ? `RPA ${job.kind} done${result["verified"] ? ", read back and verified" : ""}` : `RPA ${job.kind} failed: ${String(result["error"] ?? "unknown")}`,
      detail: { jobId, attempt: job.attempt, ...result },
    });
    if (job.callbackUrl) {
      await fetch(job.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, status: ok ? "ok" : "failed", result }),
      }).catch((err: unknown) => {
        this.events.append({
          complaintId: job.complaintId, actor: "rpa", type: "rpa_callback_failed",
          summary: "Could not reach the n8n Wait node for this job", detail: { error: String(err) },
        });
      });
    } else {
      this.waiters.resolve(jobId, { ok, result });
    }
    return job;
  }
}
