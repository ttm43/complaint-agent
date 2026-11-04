import { randomUUID } from "node:crypto";
import type { Db } from "../db/sqlite";
import type { Category, Complaint, ComplaintState, Priority } from "../domain/types";

interface ComplaintRow {
  id: string;
  call_id: string;
  state: string;
  received_at: string;
  policy_number: string | null;
  claim_id: string | null;
  pds_version: string | null;
  category: string | null;
  category_confidence: number | null;
  priority: string;
  scenario_id: string | null;
  updated_at: string;
}

const toComplaint = (r: ComplaintRow): Complaint => ({
  id: r.id,
  callId: r.call_id,
  state: r.state as ComplaintState,
  receivedAt: r.received_at,
  policyNumber: r.policy_number,
  claimId: r.claim_id,
  pdsVersion: r.pds_version,
  category: r.category as Category | null,
  categoryConfidence: r.category_confidence,
  priority: r.priority as Priority,
  scenarioId: r.scenario_id,
  updatedAt: r.updated_at,
});

export interface CreateResult {
  readonly complaint: Complaint;
  readonly created: boolean;
}

export class ComplaintRepository {
  constructor(private readonly db: Db) {}

  /** callId is the idempotency key: a repeated call returns the existing complaint. */
  createForCall(callId: string, scenarioId: string | null, receivedAt: Date): CreateResult {
    const existing = this.findByCallId(callId);
    if (existing) return { complaint: existing, created: false };
    const id = `CMP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const ts = receivedAt.toISOString();
    this.db
      .prepare(
        "INSERT INTO complaints (id, call_id, state, received_at, priority, scenario_id, updated_at) VALUES (?, ?, 'RECEIVED', ?, 'normal', ?, ?)",
      )
      .run(id, callId, ts, scenarioId, ts);
    return { complaint: this.require(id), created: true };
  }

  findById(id: string): Complaint | null {
    const row = this.db.prepare("SELECT * FROM complaints WHERE id = ?").get(id) as ComplaintRow | undefined;
    return row ? toComplaint(row) : null;
  }

  require(id: string): Complaint {
    const c = this.findById(id);
    if (!c) throw new Error(`Complaint ${id} not found`);
    return c;
  }

  findByCallId(callId: string): Complaint | null {
    const row = this.db.prepare("SELECT * FROM complaints WHERE call_id = ?").get(callId) as ComplaintRow | undefined;
    return row ? toComplaint(row) : null;
  }

  findAll(): Complaint[] {
    return (this.db.prepare("SELECT * FROM complaints ORDER BY received_at DESC").all() as unknown as ComplaintRow[]).map(toComplaint);
  }

  /** Persist a new version of a complaint. The caller builds it immutably. */
  save(c: Complaint): Complaint {
    this.db
      .prepare(
        `UPDATE complaints SET state = ?, policy_number = ?, claim_id = ?, pds_version = ?, category = ?,
         category_confidence = ?, priority = ?, updated_at = ? WHERE id = ?`,
      )
      .run(c.state, c.policyNumber, c.claimId, c.pdsVersion, c.category, c.categoryConfidence, c.priority, c.updatedAt, c.id);
    return this.require(c.id);
  }

  /** Seed helper for SLA demos: an older complaint received some days ago. */
  insertHistoric(callId: string, receivedAt: Date, state: ComplaintState, policyNumber: string, category: Category): void {
    if (this.findByCallId(callId)) return;
    const ts = receivedAt.toISOString();
    this.db
      .prepare(
        `INSERT INTO complaints (id, call_id, state, received_at, policy_number, category, priority, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'normal', ?)`,
      )
      .run(`CMP-${callId}`, callId, state, ts, policyNumber, category, ts);
  }
}
