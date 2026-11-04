import type { AppContext } from "../context";
import type { RetrievalResult } from "../domain/types";
import { RetrievalTimeoutError } from "../mock/retrieval";
import { moveTo, patch } from "./common";

// Step functions. n8n calls them over HTTP; the in-process orchestrator calls them directly.

export interface IdentityResult {
  readonly verified: boolean;
}

export function verifyIdentity(ctx: AppContext, complaintId: string, policyNumber: string, dob: string): IdentityResult {
  const policy = ctx.data.policies.find((p) => p.policyNumber === policyNumber);
  const verified = policy !== undefined && policy.dob === dob;
  ctx.events.append({
    complaintId, actor: "system", type: "policy_api",
    summary: verified ? `Policy API: ${policyNumber} and date of birth match` : `Policy API: ${policyNumber} and date of birth do not match`,
    // Never log the date of birth or policy details on a failed match.
    detail: { policyNumber, verified },
  });
  if (verified && policy) {
    moveTo(ctx, complaintId, "IDENTIFIED", "policy number and date of birth verified", { policyNumber, pdsVersion: policy.pdsVersion });
  } else {
    moveTo(ctx, complaintId, "UNVERIFIED", "identity not verified; nothing will be disclosed");
  }
  return { verified };
}

export interface ClaimSummary {
  readonly claimId: string | null;
  readonly status: string | null;
  readonly lodgedDaysAgo: number | null;
}

export function lookUpClaim(ctx: AppContext, complaintId: string): ClaimSummary {
  const c = ctx.complaints.require(complaintId);
  const claims = ctx.data.claims.filter((x) => x.policyNumber === c.policyNumber);
  const claimId = ctx.llm.pickClaim(c.scenarioId, claims.map((x) => x.claimId));
  const claim = claims.find((x) => x.claimId === claimId);
  if (claim) patch(ctx, complaintId, { claimId: claim.claimId });
  ctx.events.append({
    complaintId, actor: "system", type: "claims_api",
    summary: claim ? `Claims API: ${claim.claimId} is ${claim.status}, lodged ${claim.lodgedDaysAgo} days ago` : "Claims API: no claim found",
    detail: claim ? { ...claim } : {},
  });
  return { claimId: claim?.claimId ?? null, status: claim?.status ?? null, lodgedDaysAgo: claim?.lodgedDaysAgo ?? null };
}

export interface RetrievalOutcome {
  readonly hasBasis: boolean;
  readonly result: RetrievalResult;
}

/** Graph (mix) for decline questions, plain retrieval otherwise; mix falls back to plain on timeout. */
export async function retrieveBasis(ctx: AppContext, complaintId: string, queryText: string): Promise<RetrievalOutcome> {
  const c = ctx.complaints.require(complaintId);
  if (!c.category || !c.pdsVersion) throw new Error(`Complaint ${complaintId} has no category or PDS version yet`);
  const scenario = ctx.data.scenarios.find((s) => s.id === c.scenarioId);
  const faults = scenario?.inject?.retrieval ?? {};
  const mode = faults.forceMode ?? (c.category === "claim_denial" ? "mix" : "naive");
  const query = { text: queryText, category: c.category, pdsVersion: c.pdsVersion, mode } as const;

  let result: RetrievalResult;
  try {
    result = await ctx.retrieval.query(query, faults);
  } catch (err) {
    if (!(err instanceof RetrievalTimeoutError)) throw err;
    ctx.events.append({
      complaintId, actor: "retrieval", type: "retrieval_degraded",
      summary: `Graph retrieval timed out after ${err.afterMs} ms, falling back to plain retrieval`, detail: {},
    });
    result = await ctx.retrieval.query({ ...query, mode: "naive" }, faults);
  }

  ctx.reviews.saveRetrieval(complaintId, result);
  const usable = result.chunks.filter((ch) => ch.score >= ctx.settings.retrievalMinScore);
  ctx.events.append({
    complaintId, actor: "retrieval", type: "retrieval",
    summary: usable.length
      ? `${result.mode === "mix" ? "Graph + vector" : "Plain"} retrieval in PDS ${c.pdsVersion}: ${result.chunks.map((ch) => ch.chunkId).join(", ")}`
      : `${result.mode} retrieval found no passage above the relevance threshold`,
    detail: { mode: result.mode, pdsVersion: c.pdsVersion, chunks: result.chunks, relations: result.relations, latencyMs: result.latencyMs },
  });
  return { hasBasis: usable.length > 0, result };
}

export type InvestigationStatus = "ok" | "rpa_failed" | "no_basis";

export interface InvestigationOutcome {
  readonly status: InvestigationStatus;
  readonly notes: readonly string[];
}

/** Final verdict once claims, retrieval and the RPA read are done. */
export function concludeInvestigation(ctx: AppContext, complaintId: string, rpaOk: boolean, notes: readonly string[]): InvestigationOutcome {
  const retrieval = ctx.reviews.retrieval(complaintId);
  const hasBasis = (retrieval?.chunks ?? []).some((ch) => ch.score >= ctx.settings.retrievalMinScore);
  const status: InvestigationStatus = !rpaOk ? "rpa_failed" : hasBasis ? "ok" : "no_basis";
  ctx.events.append({
    complaintId, actor: "system", type: "investigation_done",
    summary: { ok: "Investigation complete", rpa_failed: "Investigation stopped: claim notes unavailable", no_basis: "Investigation stopped: no documented basis" }[status],
    detail: { status, notes },
  });
  return { status, notes };
}
