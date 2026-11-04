import type { AppContext } from "../context";
import { concludeInvestigation, lookUpClaim, retrieveBasis, verifyIdentity, type IdentityResult, type InvestigationOutcome } from "../steps/investigation";
import { decideResolution, type ResolutionDecision } from "../steps/resolution";
import { Waiters } from "./waiters";

/**
 * Process steps the call engine hands off. n8n decides the order and the waiting;
 * the step logic itself lives in the backend (src/steps) so it can be unit tested.
 */
export interface Orchestrator {
  readonly name: "n8n" | "inprocess";
  callEvent(complaintId: string, event: "started" | "ended", outcome?: string): Promise<void>;
  verifyIdentity(complaintId: string, policyNumber: string, dob: string): Promise<IdentityResult>;
  investigate(complaintId: string, queryText: string): Promise<InvestigationOutcome>;
  resolve(complaintId: string): Promise<ResolutionDecision>;
  /** Start the human approval wait. Returns once the wait has started, not when approved. */
  awaitApproval(complaintId: string, taskId: string): Promise<void>;
}

/** Same steps without n8n. Used by tests and as a fallback when n8n is not running. */
export class InProcessOrchestrator implements Orchestrator {
  readonly name = "inprocess" as const;
  constructor(private readonly ctx: AppContext) {}

  async callEvent(): Promise<void> {}

  async verifyIdentity(complaintId: string, policyNumber: string, dob: string): Promise<IdentityResult> {
    return verifyIdentity(this.ctx, complaintId, policyNumber, dob);
  }

  async investigate(complaintId: string, queryText: string): Promise<InvestigationOutcome> {
    lookUpClaim(this.ctx, complaintId);
    await retrieveBasis(this.ctx, complaintId, queryText);
    const c = this.ctx.complaints.require(complaintId);
    let ok = false;
    let notes: string[] = [];
    for (let attempt = 1; attempt <= this.ctx.settings.rpaAttempts && !ok; attempt += 1) {
      const out = await this.ctx.rpa.run(
        { idempotencyKey: `${complaintId}:read_notes:${attempt}`, complaintId, kind: "read_claim_notes", payload: { claimId: c.claimId }, attempt },
        this.ctx.settings.rpaTimeoutMs,
      );
      ok = out.ok;
      notes = Array.isArray(out.result["notes"]) ? (out.result["notes"] as string[]) : [];
    }
    return concludeInvestigation(this.ctx, complaintId, ok, notes);
  }

  async resolve(complaintId: string): Promise<ResolutionDecision> {
    return decideResolution(this.ctx, complaintId);
  }

  async awaitApproval(): Promise<void> {}
}

/** Sends each step to an n8n webhook. Long steps report back via /internal/steps/:key/done. */
export class N8nOrchestrator implements Orchestrator {
  readonly name = "n8n" as const;
  private readonly results = new Waiters<unknown>();

  constructor(private readonly ctx: AppContext, private readonly n8nUrl: string, private readonly backendUrl: string) {}

  private async post(hook: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.n8nUrl}/webhook/${hook}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, backend: this.backendUrl }),
    });
    if (!res.ok) throw new Error(`n8n webhook ${hook} returned ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : {};
  }

  /** Called by the route that n8n posts results to. */
  stepDone(key: string, value: unknown): boolean {
    return this.results.resolve(key, value);
  }

  async callEvent(complaintId: string, event: "started" | "ended", outcome?: string): Promise<void> {
    await this.post("complaint-main", { complaintId, event, outcome: outcome ?? null });
  }

  async verifyIdentity(complaintId: string, policyNumber: string, dob: string): Promise<IdentityResult> {
    return (await this.post("sub-identity", { complaintId, policyNumber, dob })) as IdentityResult;
  }

  async investigate(complaintId: string, queryText: string): Promise<InvestigationOutcome> {
    const key = `investigation:${complaintId}`;
    const done = this.results.wait(key, this.ctx.settings.stepTimeoutMs, () => ({ status: "rpa_failed", notes: [] }) satisfies InvestigationOutcome);
    await this.post("sub-investigation", { complaintId, queryText, attempts: this.ctx.settings.rpaAttempts });
    return (await done) as InvestigationOutcome;
  }

  async resolve(complaintId: string): Promise<ResolutionDecision> {
    return (await this.post("sub-resolution", { complaintId })) as ResolutionDecision;
  }

  async awaitApproval(complaintId: string, taskId: string): Promise<void> {
    await this.post("sub-human-review", { complaintId, taskId });
  }
}
