import type { AppContext } from "../context";
import { startHold } from "../domain/hold";
import { isAffirmative, isValidDob, parseKeypad, parsePolicyNumber, readBack } from "../domain/identity";
import type { ActionRequest } from "../domain/types";
import { classify, detectRisk, extractDob } from "../mock/models";
import type { Utterance } from "../phrases";
import { handoff, moveTo, patch } from "../steps/common";
import type { InvestigationOutcome } from "../steps/investigation";
import { executeAction, proposeClosure, registerComplaint, requestApproval } from "../steps/resolution";
import type { Orchestrator } from "./orchestrator";

export type Phase = "policy" | "confirm_policy" | "keypad" | "dob" | "complaint" | "clarify" | "plan" | "ended";

export interface CustomerTurn {
  readonly text?: string;
  readonly say?: string;
  readonly confidence?: number;
  readonly keypad?: string;
}

interface Session {
  phase: Phase;
  candidatePolicy: string | null;
  confirmedPolicy: string | null;
  denials: number;
  policyMisses: number;
  dobMisses: number;
  notCaught: number;
  complaintText: string;
  pendingAction: ActionRequest | null;
  queue: Promise<unknown>;
}

const LOW_ASR_CONFIDENCE = 0.5;

/**
 * The conversation. Fixed phrases and hold lines are chosen here from backend state,
 * never by the LLM. Process steps go through the orchestrator (n8n or in-process).
 */
export class CallEngine {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ctx: AppContext, private readonly orch: Orchestrator) {}

  async start(callId: string, scenarioId: string | null): Promise<{ complaintId: string; created: boolean }> {
    const { complaint, created } = this.ctx.complaints.createForCall(callId, scenarioId, new Date());
    if (!created) {
      this.ctx.events.append({
        complaintId: complaint.id, actor: "system", type: "duplicate_call",
        summary: `Call ${callId} submitted again; existing complaint returned, nothing registered twice`, detail: { callId },
      });
      return { complaintId: complaint.id, created };
    }
    this.ctx.events.append({
      complaintId: complaint.id, actor: "system", type: "complaint_created",
      summary: `Complaint registered at call start; 30-day clock starts ${complaint.receivedAt}`,
      detail: { callId, scenarioId, receivedAt: complaint.receivedAt },
    });
    this.sessions.set(complaint.id, {
      phase: "policy", candidatePolicy: null, confirmedPolicy: null, denials: 0, policyMisses: 0,
      dobMisses: 0, notCaught: 0, complaintText: "", pendingAction: null, queue: Promise.resolve(),
    });
    await this.orch.callEvent(complaint.id, "started").catch((e: unknown) => this.warn(complaint.id, "call start event not delivered", e));
    this.say(complaint.id, this.ctx.phrases.fixed("GREETING"));
    this.say(complaint.id, this.ctx.phrases.fixed("ASK_POLICY"));
    this.awaitCustomer(complaint.id, "policy");
    return { complaintId: complaint.id, created };
  }

  phase(complaintId: string): Phase | null {
    return this.sessions.get(complaintId)?.phase ?? null;
  }

  /** Turns for one call are processed strictly in order. */
  turn(complaintId: string, input: CustomerTurn): Promise<Phase> {
    const s = this.sessions.get(complaintId);
    if (!s) return Promise.reject(new Error(`No active call for complaint ${complaintId}`));
    const run = s.queue.then(() => this.handle(complaintId, s, input));
    s.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(id: string, s: Session, input: CustomerTurn): Promise<Phase> {
    if (s.phase === "ended") return s.phase;
    const text = input.text ?? "";
    this.ctx.events.append({
      complaintId: id, actor: "customer", type: "customer_said",
      summary: input.keypad ? `(keypad) ${input.keypad}` : text,
      detail: { asr: text, said: input.say ?? null, confidence: input.confidence ?? null, keypad: input.keypad ?? null },
    });

    if (text) {
      const risk = detectRisk(text);
      if (risk) {
        this.ctx.events.append({
          complaintId: id, actor: "risk", type: "risk_signal",
          summary: `Risk signal: ${risk.type} ("${risk.matched}", ${risk.confidence})`, detail: { ...risk },
        });
        patch(this.ctx, id, { priority: "high" });
        return this.endWithHandoff(id, s, "HANDOFF_PRIORITY", { kind: "handoff", priority: "high", reason: `risk signal: ${risk.type}` });
      }
    }

    switch (s.phase) {
      case "policy": return this.onPolicy(id, s, text);
      case "confirm_policy": return this.onConfirmPolicy(id, s, text);
      case "keypad": return this.onKeypad(id, s, input.keypad ?? "");
      case "dob": return this.onDob(id, s, text);
      case "complaint":
      case "clarify": return this.onComplaint(id, s, text, input.confidence ?? 1);
      case "plan": return this.onPlan(id, s, text);
    }
  }

  private onPolicy(id: string, s: Session, text: string): Phase {
    const parsed = parsePolicyNumber(text);
    if (!parsed) {
      s.policyMisses += 1;
      if (s.policyMisses >= 2) return this.ask(id, s, "keypad", "ASK_KEYPAD");
      return this.ask(id, s, "policy", "NOT_CAUGHT");
    }
    s.candidatePolicy = parsed;
    this.say(id, this.ctx.phrases.template("CONFIRM_POLICY", { readback: readBack(parsed) }));
    return this.wait(id, s, "confirm_policy");
  }

  private onConfirmPolicy(id: string, s: Session, text: string): Phase {
    if (isAffirmative(text) && s.candidatePolicy) {
      s.confirmedPolicy = s.candidatePolicy;
      this.event(id, "policy_confirmed", `Customer confirmed ${s.confirmedPolicy} on read-back`);
      return this.ask(id, s, "dob", "ASK_DOB");
    }
    s.denials += 1;
    this.event(id, "readback_denied", `Customer rejected the read-back of ${s.candidatePolicy ?? "?"} (${s.denials}/2): ASR likely misheard`);
    if (s.denials >= 2) return this.ask(id, s, "keypad", "ASK_KEYPAD");
    const again = parsePolicyNumber(text);
    if (again) return this.onPolicy(id, s, text);
    return this.ask(id, s, "policy", "ASK_POLICY_AGAIN");
  }

  private onKeypad(id: string, s: Session, digits: string): Phase {
    const parsed = parseKeypad(digits);
    if (!parsed) return this.ask(id, s, "keypad", "ASK_KEYPAD");
    s.confirmedPolicy = parsed;
    this.event(id, "policy_confirmed", `Policy number taken from keypad: ${parsed} (exact input, no ASR)`);
    return this.ask(id, s, "dob", "ASK_DOB");
  }

  private async onDob(id: string, s: Session, text: string): Promise<Phase> {
    const dob = extractDob(text);
    if (!dob || !isValidDob(dob, new Date())) {
      s.dobMisses += 1;
      if (s.dobMisses < 2) return this.ask(id, s, "dob", "NOT_CAUGHT");
    }
    const result = await this.orch.verifyIdentity(id, s.confirmedPolicy ?? "", dob ?? "");
    if (!result.verified) {
      return this.endWithHandoff(id, s, "HANDOFF_UNVERIFIED", { kind: "callback", reason: "identity not verified; call back after checking identity" });
    }
    return this.ask(id, s, "complaint", "ASK_COMPLAINT");
  }

  private async onComplaint(id: string, s: Session, text: string, confidence: number): Promise<Phase> {
    if (confidence < LOW_ASR_CONFIDENCE && s.notCaught === 0) {
      s.notCaught += 1;
      this.event(id, "low_asr_confidence", `ASR confidence ${confidence} is low; asking the customer to repeat`);
      return this.ask(id, s, s.phase, "NOT_CAUGHT");
    }
    s.complaintText = `${s.complaintText} ${text}`.trim();
    const cls = classify(s.complaintText);
    this.ctx.events.append({
      complaintId: id, actor: "classifier", type: "classified",
      summary: `Classifier: ${cls.category} (${cls.confidence}), threshold ${this.ctx.settings.classifierThreshold}`,
      detail: { text: s.complaintText, ...cls },
    });
    if (cls.confidence < this.ctx.settings.classifierThreshold) {
      if (s.phase === "complaint") return this.ask(id, s, "clarify", "ASK_CLARIFY");
      return this.endWithHandoff(id, s, "HANDOFF_LIVE", { kind: "handoff", reason: "classification still uncertain after one follow-up question" });
    }
    moveTo(this.ctx, id, "CLASSIFIED", `${cls.category} at ${cls.confidence}`, { category: cls.category, categoryConfidence: cls.confidence });
    return this.investigateAndResolve(id, s);
  }

  private async investigateAndResolve(id: string, s: Session): Promise<Phase> {
    moveTo(this.ctx, id, "INVESTIGATING", "looking up claim, notes and documents");
    let gaveUp = false;
    const hold = startHold(
      (phraseId) => this.say(id, this.ctx.phrases.fixed(phraseId)),
      () => { gaveUp = true; },
    );
    let outcome: InvestigationOutcome;
    try {
      outcome = await this.orch.investigate(id, s.complaintText);
    } finally {
      hold.stop();
    }
    if (gaveUp) {
      return this.endWithHandoff(id, s, "HANDOFF_CALLBACK", { kind: "callback", reason: "lookup took longer than 30 seconds" });
    }
    if (outcome.status === "rpa_failed") {
      return this.endWithHandoff(id, s, "HANDOFF_CALLBACK", { kind: "rpa_failed", reason: "claim notes could not be read from the legacy system after retries" });
    }
    if (outcome.status === "no_basis") {
      return this.endWithHandoff(id, s, "HANDOFF_LIVE", { kind: "handoff", reason: "no documented basis found; agent will not explain without one" });
    }

    const decision = await this.orch.resolve(id);
    if (decision.route === "execute" && decision.action) {
      moveTo(this.ctx, id, "RESOLVING", `${decision.action.type} allowed`);
      s.pendingAction = decision.action;
      this.say(id, this.ctx.phrases.free(decision.reply));
      return this.ask(id, s, "plan", "CONFIRM_PLAN");
    }
    if (decision.route === "approval" && decision.action) {
      const taskId = requestApproval(this.ctx, id, decision.action, decision.reason);
      this.say(id, this.ctx.phrases.free(decision.reply));
      const c = this.ctx.complaints.require(id);
      if (c.category === "claim_denial") this.say(id, this.ctx.phrases.fixed("AFCA_NOTICE"));
      this.say(id, this.ctx.phrases.fixed("CLOSING"));
      await this.end(id, s, "pending_approval");
      await this.orch.awaitApproval(id, taskId).catch((e: unknown) => this.warn(id, "approval wait not started in n8n", e));
      await registerComplaint(this.ctx, id, "pending_approval", decision.reason);
      return "ended";
    }
    return this.endWithHandoff(id, s, "HANDOFF_LIVE", { kind: "handoff", reason: decision.reason });
  }

  private async onPlan(id: string, s: Session, text: string): Promise<Phase> {
    const action = s.pendingAction;
    if (!isAffirmative(text) || !action) {
      this.event(id, "plan_rejected", "Customer did not accept the proposed resolution");
      this.say(id, this.ctx.phrases.fixed("AFCA_NOTICE"));
      return this.endWithHandoff(id, s, "HANDOFF_LIVE", { kind: "handoff", reason: "customer did not accept the resolution" });
    }
    this.event(id, "plan_accepted", `Customer accepted: ${action.type}`);
    this.say(id, this.ctx.phrases.fixed("CLOSING"));
    await this.end(id, s, "resolved");
    if (!(await executeAction(this.ctx, id, action))) {
      handoff(this.ctx, id, { kind: "rpa_failed", reason: "agreed action could not be written to the claims system" });
      return "ended";
    }
    if (await registerComplaint(this.ctx, id, "resolved_pending_review", action.type)) proposeClosure(this.ctx, id, action.customerText ?? action.type);
    return "ended";
  }

  // ---------- helpers ----------

  private async endWithHandoff(id: string, s: Session, phraseId: string, h: Parameters<typeof handoff>[2]): Promise<Phase> {
    this.say(id, this.ctx.phrases.fixed(phraseId));
    handoff(this.ctx, id, h);
    await this.end(id, s, h.kind);
    await registerComplaint(this.ctx, id, `human_${h.kind}`, h.reason);
    return "ended";
  }

  private async end(id: string, s: Session, outcome: string): Promise<void> {
    s.phase = "ended";
    this.ctx.events.append({ complaintId: id, actor: "system", type: "call_ended", summary: `Call ended (${outcome})`, detail: { outcome } });
    await this.orch.callEvent(id, "ended", outcome).catch((e: unknown) => this.warn(id, "call end event not delivered", e));
  }

  private ask(id: string, s: Session, phase: Phase, phraseId: string): Phase {
    this.say(id, this.ctx.phrases.fixed(phraseId));
    return this.wait(id, s, phase);
  }

  private wait(id: string, s: Session, phase: Phase): Phase {
    s.phase = phase;
    this.awaitCustomer(id, phase);
    return phase;
  }

  private say(id: string, u: Utterance): void {
    this.ctx.events.append({ complaintId: id, actor: "agent", type: "agent_said", summary: u.text, detail: { audioId: u.audioId, phraseId: u.phraseId } });
  }

  private awaitCustomer(id: string, phase: Phase): void {
    this.ctx.events.append({
      complaintId: id, actor: "system", type: "await_customer", summary: `Waiting for customer (${phase})`,
      detail: { phase, expects: phase === "keypad" ? "keypad" : "speech" },
    });
  }

  private event(id: string, type: string, summary: string): void {
    this.ctx.events.append({ complaintId: id, actor: "system", type, summary, detail: {} });
  }

  private warn(id: string, what: string, err: unknown): void {
    this.ctx.events.append({ complaintId: id, actor: "system", type: "warning", summary: what, detail: { error: err instanceof Error ? err.message : String(err) } });
  }
}
