import type { ActionRequest, ActionType, Category, RetrievedChunk } from "./types";
import { checkCitations } from "./citations";

export type Route = "execute" | "approval" | "human";

export interface Decision {
  readonly route: Route;
  readonly reason: string;
  readonly citationProblems: readonly string[];
}

/** Anything that moves money or changes a claim decision. Never on the whitelist. */
const NEEDS_APPROVAL: ReadonlySet<ActionType> = new Set(["adjust_payout", "reassess_decision", "compensation"]);

/** Actions the agent may run on its own, per category. */
const WHITELIST: Readonly<Record<Category, ReadonlySet<ActionType>>> = {
  claim_delay: new Set(["explain_reason", "expedite_assessment", "resend_document", "update_contact"]),
  claim_denial: new Set(["explain_reason", "resend_document", "update_contact"]),
  payout_amount: new Set(["explain_reason", "resend_document", "update_contact"]),
  repair_quality: new Set(["explain_reason", "book_repair_inspection", "resend_document", "update_contact"]),
};

/** Actions the agent explains to the customer, so they must rest on a verified source. */
const NEEDS_BASIS: ReadonlySet<ActionType> = new Set([
  "explain_reason",
  "expedite_assessment",
  "book_repair_inspection",
  "adjust_payout",
  "reassess_decision",
  "compensation",
]);

export interface DecisionContext {
  readonly category: Category;
  readonly retrieved: readonly RetrievedChunk[];
  readonly pdsVersion: string | null;
}

export function decide(action: ActionRequest, ctx: DecisionContext): Decision {
  if (NEEDS_BASIS.has(action.type)) {
    const check = checkCitations(action.citations, ctx.retrieved, ctx.pdsVersion);
    if (!check.ok) {
      return { route: "human", reason: "no verified basis for the explanation", citationProblems: check.problems };
    }
  }
  if (NEEDS_APPROVAL.has(action.type)) {
    return { route: "approval", reason: `${action.type} moves money or changes a claim decision`, citationProblems: [] };
  }
  if (!WHITELIST[ctx.category].has(action.type)) {
    return { route: "human", reason: `${action.type} is not whitelisted for ${ctx.category}`, citationProblems: [] };
  }
  return { route: "execute", reason: "whitelisted action with verified basis", citationProblems: [] };
}
