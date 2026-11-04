import { config } from "./config";
import { openDb, type Db } from "./db/sqlite";
import { RpaBroker } from "./engine/rpaBroker";
import { loadMockData, type MockData } from "./mock/data";
import { ScriptedLlm } from "./mock/llm";
import { MockRetrieval, type RetrievalTiming } from "./mock/retrieval";
import { Phrases } from "./phrases";
import { ComplaintRepository } from "./store/complaints";
import { EventLog } from "./store/events";
import { ReviewRepository, RpaJobRepository, TaskRepository } from "./store/work";

export interface Settings {
  readonly classifierThreshold: number;
  readonly retrievalMinScore: number;
  readonly rpaAttempts: number;
  readonly rpaTimeoutMs: number;
  readonly reviewTarget: number;
  readonly stepTimeoutMs: number;
}

export interface AppContext {
  readonly db: Db;
  readonly data: MockData;
  readonly complaints: ComplaintRepository;
  readonly events: EventLog;
  readonly tasks: TaskRepository;
  readonly reviews: ReviewRepository;
  readonly rpa: RpaBroker;
  readonly retrieval: MockRetrieval;
  readonly llm: ScriptedLlm;
  readonly phrases: Phrases;
  readonly settings: Settings;
  /** Mutable demo setting shown on the page: review mode switch is per category in stats; this is the sample rate. */
  sampleRate: number;
}

export interface ContextOptions {
  readonly dbPath?: string;
  readonly timing?: RetrievalTiming;
  readonly settings?: Partial<Settings>;
}

export function createContext(opts: ContextOptions = {}): AppContext {
  const db = openDb(opts.dbPath ?? config.dbPath);
  const data = loadMockData();
  const events = new EventLog(db);
  return {
    db,
    data,
    complaints: new ComplaintRepository(db),
    events,
    tasks: new TaskRepository(db),
    reviews: new ReviewRepository(db),
    rpa: new RpaBroker(new RpaJobRepository(db), events),
    retrieval: new MockRetrieval(data, opts.timing ?? { mixLatencyMs: config.retrievalMixLatencyMs, timeoutMs: config.retrievalTimeoutMs }),
    llm: new ScriptedLlm(data),
    phrases: new Phrases(data.phrases),
    settings: {
      classifierThreshold: config.classifierThreshold,
      retrievalMinScore: config.retrievalMinScore,
      rpaAttempts: config.rpaAttempts,
      rpaTimeoutMs: config.rpaTimeoutMs,
      reviewTarget: config.reviewTarget,
      stepTimeoutMs: config.stepTimeoutMs,
      ...opts.settings,
    },
    sampleRate: config.sampleRateDefault,
  };
}
