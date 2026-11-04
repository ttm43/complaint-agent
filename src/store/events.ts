import { EventEmitter } from "node:events";
import type { Db } from "../db/sqlite";

export type Actor = "system" | "agent" | "customer" | "n8n" | "rpa" | "human" | "retrieval" | "classifier" | "risk";

export interface AuditEvent {
  readonly seq: number;
  readonly complaintId: string | null;
  readonly ts: string;
  readonly actor: Actor;
  readonly type: string;
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type NewEvent = Omit<AuditEvent, "seq" | "ts">;

interface EventRow {
  seq: number;
  complaint_id: string | null;
  ts: string;
  actor: string;
  type: string;
  summary: string;
  detail: string;
}

const toEvent = (r: EventRow): AuditEvent => ({
  seq: r.seq,
  complaintId: r.complaint_id,
  ts: r.ts,
  actor: r.actor as Actor,
  type: r.type,
  summary: r.summary,
  detail: JSON.parse(r.detail) as Record<string, unknown>,
});

/** Append-only audit log. Every write is also pushed to live subscribers (the demo page). */
export class EventLog {
  private readonly bus = new EventEmitter();

  constructor(private readonly db: Db) {
    this.bus.setMaxListeners(100);
  }

  append(e: NewEvent): AuditEvent {
    const ts = new Date().toISOString();
    const res = this.db
      .prepare("INSERT INTO events (complaint_id, ts, actor, type, summary, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.complaintId, ts, e.actor, e.type, e.summary, JSON.stringify(e.detail));
    const event: AuditEvent = { ...e, seq: Number(res.lastInsertRowid), ts };
    this.bus.emit("event", event);
    return event;
  }

  forComplaint(complaintId: string): AuditEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE complaint_id = ? ORDER BY seq").all(complaintId) as unknown as EventRow[]).map(toEvent);
  }

  since(seq: number, limit = 500): AuditEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as unknown as EventRow[]).map(toEvent);
  }

  subscribe(fn: (e: AuditEvent) => void): () => void {
    this.bus.on("event", fn);
    return () => this.bus.off("event", fn);
  }
}
