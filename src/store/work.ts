import { randomUUID } from "node:crypto";
import type { Db } from "../db/sqlite";
import { CATEGORIES, type Category, type Priority, type RetrievalResult } from "../domain/types";
import type { CategoryStats, ReviewMode } from "../domain/review";

// ---------- RPA jobs ----------

export type RpaKind = "read_claim_notes" | "write_claim_note" | "write_complaint";
export type RpaStatus = "queued" | "running" | "succeeded" | "failed";

export interface RpaJob {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly complaintId: string | null;
  readonly kind: RpaKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly callbackUrl: string | null;
  readonly attempt: number;
  readonly status: RpaStatus;
  readonly result: Readonly<Record<string, unknown>> | null;
}

interface RpaRow {
  id: string; idempotency_key: string; complaint_id: string | null; kind: string; payload: string;
  callback_url: string | null; attempt: number; status: string; result: string | null;
}

const toJob = (r: RpaRow): RpaJob => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  complaintId: r.complaint_id,
  kind: r.kind as RpaKind,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  callbackUrl: r.callback_url,
  attempt: r.attempt,
  status: r.status as RpaStatus,
  result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null,
});

export interface NewRpaJob {
  readonly idempotencyKey: string;
  readonly complaintId: string | null;
  readonly kind: RpaKind;
  readonly payload: Record<string, unknown>;
  readonly callbackUrl: string | null;
  readonly attempt: number;
}

export class RpaJobRepository {
  constructor(private readonly db: Db) {}

  /** A succeeded job with the same idempotency key is returned instead of queuing a duplicate write. */
  submit(j: NewRpaJob): { job: RpaJob; duplicate: boolean } {
    const done = this.db
      .prepare("SELECT * FROM rpa_jobs WHERE idempotency_key = ? AND status = 'succeeded' LIMIT 1")
      .get(j.idempotencyKey) as RpaRow | undefined;
    if (done) return { job: toJob(done), duplicate: true };
    const id = `RPA-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO rpa_jobs (id, idempotency_key, complaint_id, kind, payload, callback_url, attempt, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, j.idempotencyKey, j.complaintId, j.kind, JSON.stringify(j.payload), j.callbackUrl, j.attempt, now, now);
    return { job: this.require(id), duplicate: false };
  }

  /** Hand the oldest queued job to a worker. */
  claimNext(): RpaJob | null {
    const row = this.db.prepare("SELECT * FROM rpa_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as RpaRow | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE rpa_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return this.require(row.id);
  }

  finish(id: string, status: "succeeded" | "failed", result: Record<string, unknown>): RpaJob {
    this.db
      .prepare("UPDATE rpa_jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(result), new Date().toISOString(), id);
    return this.require(id);
  }

  require(id: string): RpaJob {
    const row = this.db.prepare("SELECT * FROM rpa_jobs WHERE id = ?").get(id) as RpaRow | undefined;
    if (!row) throw new Error(`RPA job ${id} not found`);
    return toJob(row);
  }
}

// ---------- Human tasks (queue, approvals, reviews) ----------

export type TaskKind = "handoff" | "callback" | "rpa_failed" | "approval" | "closure_review" | "sla";
export type TaskStatus = "open" | "approved" | "rejected" | "done";

export interface HumanTask {
  readonly id: string;
  readonly complaintId: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly priority: Priority;
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly resumeUrl: string | null;
  readonly createdAt: string;
}

interface TaskRow {
  id: string; complaint_id: string; kind: string; status: string; priority: string;
  summary: string; detail: string; resume_url: string | null; created_at: string;
}

const toTask = (r: TaskRow): HumanTask => ({
  id: r.id,
  complaintId: r.complaint_id,
  kind: r.kind as TaskKind,
  status: r.status as TaskStatus,
  priority: r.priority as Priority,
  summary: r.summary,
  detail: JSON.parse(r.detail) as Record<string, unknown>,
  resumeUrl: r.resume_url,
  createdAt: r.created_at,
});

export class TaskRepository {
  constructor(private readonly db: Db) {}

  create(t: Omit<HumanTask, "id" | "status" | "createdAt">): HumanTask {
    const id = `TSK-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO tasks (id, complaint_id, kind, status, priority, summary, detail, resume_url, created_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      )
      .run(id, t.complaintId, t.kind, t.priority, t.summary, JSON.stringify(t.detail), t.resumeUrl, new Date().toISOString());
    return this.require(id);
  }

  setResumeUrl(id: string, url: string): HumanTask {
    this.db.prepare("UPDATE tasks SET resume_url = ? WHERE id = ?").run(url, id);
    return this.require(id);
  }

  resolve(id: string, status: Exclude<TaskStatus, "open">): HumanTask {
    this.db.prepare("UPDATE tasks SET status = ?, resolved_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.require(id);
  }

  open(): HumanTask[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY priority = 'high' DESC, created_at").all() as unknown as TaskRow[]).map(toTask);
  }

  forComplaint(complaintId: string): HumanTask[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE complaint_id = ? ORDER BY created_at").all(complaintId) as unknown as TaskRow[]).map(toTask);
  }

  require(id: string): HumanTask {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    return toTask(row);
  }
}

// ---------- Review statistics, retrieval results, training data ----------

interface StatsRow { category: string; reviewed: number; misclassified: number; wrong_citation: number; mode: string }

export class ReviewRepository {
  constructor(private readonly db: Db) {
    for (const c of CATEGORIES) {
      db.prepare("INSERT OR IGNORE INTO review_stats VALUES (?, 0, 0, 0, 'full')").run(c);
    }
  }

  all(): CategoryStats[] {
    return (this.db.prepare("SELECT * FROM review_stats ORDER BY category").all() as unknown as StatsRow[]).map((r) => ({
      category: r.category as Category,
      reviewed: r.reviewed,
      misclassified: r.misclassified,
      wrongCitation: r.wrong_citation,
      mode: r.mode as ReviewMode,
    }));
  }

  get(category: Category): CategoryStats {
    const s = this.all().find((x) => x.category === category);
    if (!s) throw new Error(`No review stats for ${category}`);
    return s;
  }

  save(s: CategoryStats): void {
    this.db
      .prepare("UPDATE review_stats SET reviewed = ?, misclassified = ?, wrong_citation = ?, mode = ? WHERE category = ?")
      .run(s.reviewed, s.misclassified, s.wrongCitation, s.mode, s.category);
  }

  saveRetrieval(complaintId: string, r: RetrievalResult): void {
    this.db.prepare("INSERT OR REPLACE INTO retrievals VALUES (?, ?)").run(complaintId, JSON.stringify(r));
  }

  retrieval(complaintId: string): RetrievalResult | null {
    const row = this.db.prepare("SELECT result FROM retrievals WHERE complaint_id = ?").get(complaintId) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as RetrievalResult) : null;
  }

  addTrainingExample(complaintId: string, text: string, predicted: Category, corrected: Category): void {
    this.db
      .prepare("INSERT INTO training_examples (complaint_id, text, predicted, corrected, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(complaintId, text, predicted, corrected, new Date().toISOString());
  }

  trainingExamples(): Array<{ complaintId: string; text: string; predicted: string; corrected: string }> {
    return (this.db.prepare("SELECT complaint_id, text, predicted, corrected FROM training_examples").all() as Array<Record<string, string>>).map((r) => ({
      complaintId: r.complaint_id ?? "",
      text: r.text ?? "",
      predicted: r.predicted ?? "",
      corrected: r.corrected ?? "",
    }));
  }
}
