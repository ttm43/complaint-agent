import type { RetrievedChunk } from "./types";

export interface CitationCheck {
  readonly ok: boolean;
  readonly verified: readonly RetrievedChunk[];
  readonly problems: readonly string[];
}

/**
 * Every cited chunk must appear in this complaint's retrieval results, and every PDS
 * chunk must come from the PDS version that applies to the customer's policy.
 */
export function checkCitations(
  cited: readonly string[],
  retrieved: readonly RetrievedChunk[],
  policyPdsVersion: string | null,
): CitationCheck {
  if (cited.length === 0) return { ok: false, verified: [], problems: ["no citation given"] };

  const byId = new Map(retrieved.map((c) => [c.chunkId, c]));
  const problems: string[] = [];
  const verified: RetrievedChunk[] = [];

  for (const id of cited) {
    const chunk = byId.get(id);
    if (!chunk) {
      problems.push(`${id} was not in the retrieval results`);
      continue;
    }
    if (chunk.docId.startsWith("PDS") && chunk.docVersion !== policyPdsVersion) {
      problems.push(`${id} is PDS ${chunk.docVersion}, policy uses PDS ${policyPdsVersion ?? "unknown"}`);
      continue;
    }
    verified.push(chunk);
  }
  return { ok: problems.length === 0, verified, problems };
}
