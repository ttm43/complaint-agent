import type { Category, GraphRelation, RetrievalResult, RetrievedChunk } from "../domain/types";
import type { DocChunk, MockData } from "./data";

// Stand-in for LightRAG. Same output shape as its context mode: source chunks plus,
// in mix mode, the graph relations that linked them. Real retrieval is a LightRAG
// workspace per PDS version; here the version filter is a plain field match.

export interface RetrievalQuery {
  readonly text: string;
  readonly category: Category;
  readonly pdsVersion: string;
  readonly mode: "naive" | "mix";
}

export interface RetrievalFaults {
  readonly mixTimeout?: boolean;
  readonly empty?: boolean;
}

export class RetrievalTimeoutError extends Error {
  constructor(readonly mode: string, readonly afterMs: number) {
    super(`${mode} retrieval timed out after ${afterMs} ms`);
    this.name = "RetrievalTimeoutError";
  }
}

export interface RetrievalTiming {
  readonly mixLatencyMs: number;
  readonly timeoutMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockRetrieval {
  constructor(private readonly data: MockData, private readonly timing: RetrievalTiming) {}

  async query(q: RetrievalQuery, faults: RetrievalFaults = {}): Promise<RetrievalResult> {
    const started = Date.now();
    if (q.mode === "mix") {
      if (faults.mixTimeout) {
        await sleep(this.timing.timeoutMs);
        throw new RetrievalTimeoutError("mix", this.timing.timeoutMs);
      }
      await sleep(this.timing.mixLatencyMs);
    } else {
      await sleep(40);
    }

    const seeds = faults.empty ? [] : this.rank(q);
    const { chunks, relations } = q.mode === "mix" ? this.expand(seeds, q.pdsVersion) : { chunks: seeds, relations: [] };
    return { mode: q.mode, chunks, relations, latencyMs: Date.now() - started };
  }

  /** Version filter first (hard), then category scope, then keyword score. */
  private rank(q: RetrievalQuery): RetrievedChunk[] {
    const text = q.text.toLowerCase();
    return this.data.chunks
      .filter((c) => this.versionOk(c, q.pdsVersion) && c.categories.includes(q.category) && c.docId !== "AFCA")
      .map((c) => ({ c, score: score(c, text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(({ c, score: s }) => toRetrieved(c, s));
  }

  /** Mix mode: follow graph relations one hop from the seed chunks, staying inside the policy's PDS version. */
  private expand(seeds: RetrievedChunk[], pdsVersion: string): { chunks: RetrievedChunk[]; relations: GraphRelation[] } {
    const ids = new Set(seeds.map((s) => s.chunkId));
    const relations = this.data.relations.filter((r) => ids.has(r.from) || ids.has(r.to));
    const linked = this.data.chunks.filter(
      (c) => !ids.has(c.chunkId) && this.versionOk(c, pdsVersion) && relations.some((r) => r.from === c.chunkId || r.to === c.chunkId),
    );
    const keptRelations = relations.filter((r) => !isOtherVersion(r.from, pdsVersion) && !isOtherVersion(r.to, pdsVersion));
    return { chunks: [...seeds, ...linked.map((c) => toRetrieved(c, 0.5))], relations: keptRelations };
  }

  private versionOk(c: DocChunk, pdsVersion: string): boolean {
    return c.docId !== "PDS" || c.docVersion === pdsVersion;
  }
}

function score(c: DocChunk, text: string): number {
  const hits = c.keywords.filter((k) => text.includes(k)).length;
  return hits === 0 ? 0 : Math.min(1, 0.25 + hits * 0.2);
}

function isOtherVersion(id: string, pdsVersion: string): boolean {
  const m = id.match(/^PDS(\d{2})-/);
  return m !== null && `20${m[1]}` !== pdsVersion;
}

function toRetrieved(c: DocChunk, s: number): RetrievedChunk {
  return { chunkId: c.chunkId, docId: c.docId, docVersion: c.docVersion, clause: c.clause, title: c.title, text: c.text, score: Math.round(s * 100) / 100 };
}
