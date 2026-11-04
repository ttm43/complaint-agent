// Shared domain vocabulary. Names follow docs/plan.md.

export const CATEGORIES = ["claim_delay", "claim_denial", "payout_amount", "repair_quality"] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATES = [
  "RECEIVED",
  "IDENTIFIED",
  "UNVERIFIED",
  "CLASSIFIED",
  "INVESTIGATING",
  "PENDING_APPROVAL",
  "RESOLVING",
  "PENDING_REVIEW",
  "CLOSED",
  "REOPENED",
  "HUMAN_HANDLING",
] as const;
export type ComplaintState = (typeof STATES)[number];

export type Priority = "normal" | "high";

export interface Complaint {
  readonly id: string;
  readonly callId: string;
  readonly state: ComplaintState;
  /** ISO timestamp of the first call. Never changes, even on reopen. */
  readonly receivedAt: string;
  readonly policyNumber: string | null;
  readonly claimId: string | null;
  readonly pdsVersion: string | null;
  readonly category: Category | null;
  readonly categoryConfidence: number | null;
  readonly priority: Priority;
  readonly scenarioId: string | null;
  readonly updatedAt: string;
}

export const ACTION_TYPES = [
  "explain_reason",
  "resend_document",
  "expedite_assessment",
  "update_contact",
  "book_repair_inspection",
  "adjust_payout",
  "reassess_decision",
  "compensation",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionRequest {
  readonly type: ActionType;
  readonly citations: readonly string[];
  readonly params?: Readonly<Record<string, string | number>>;
  /** What the agent will say to the customer when the action goes ahead. */
  readonly customerText?: string;
}

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly docId: string;
  /** PDS version such as "2024", or "current" for documents that are not versioned. */
  readonly docVersion: string;
  readonly clause: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
}

export interface GraphRelation {
  readonly from: string;
  readonly relation: string;
  readonly to: string;
}

export interface RetrievalResult {
  readonly mode: "naive" | "mix";
  readonly chunks: readonly RetrievedChunk[];
  readonly relations: readonly GraphRelation[];
  readonly latencyMs: number;
}
