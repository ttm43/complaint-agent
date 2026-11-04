import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config";
import { ACTION_TYPES, CATEGORIES } from "../domain/types";

// All mock data is validated on load: a typo in a JSON file fails fast with a clear message.

const PolicySchema = z.object({
  policyNumber: z.string().regex(/^POL-\d{4}$/),
  holder: z.string(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startDate: z.string(),
  pdsVersion: z.string(),
  vehicle: z.string(),
  phone: z.string(),
});
export type Policy = z.infer<typeof PolicySchema>;

const ClaimSchema = z.object({
  claimId: z.string(),
  policyNumber: z.string(),
  type: z.string(),
  status: z.string(),
  lodgedDaysAgo: z.number(),
  decisionDaysAgo: z.number().optional(),
  declineClause: z.string().optional(),
  offerAmount: z.number().optional(),
  repairCompletedDaysAgo: z.number().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

const ChunkSchema = z.object({
  chunkId: z.string(),
  docId: z.string(),
  docVersion: z.string(),
  clause: z.string(),
  title: z.string(),
  categories: z.array(z.enum(CATEGORIES)),
  keywords: z.array(z.string()),
  text: z.string(),
});
export type DocChunk = z.infer<typeof ChunkSchema>;

const RelationSchema = z.object({ from: z.string(), relation: z.string(), to: z.string() });

const TurnSchema = z.object({
  say: z.string(),
  asr: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  keypad: z.string().optional(),
});
export type ScenarioTurn = z.infer<typeof TurnSchema>;

const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  featured: z.boolean(),
  tests: z.string(),
  customer: z.object({ name: z.string(), voice: z.enum(["male", "female"]) }),
  turns: z.array(TurnSchema),
  agent: z
    .object({
      claimId: z.string(),
      reply: z.string().optional(),
      action: z
        .object({
          type: z.enum(ACTION_TYPES),
          citations: z.array(z.string()),
          params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        })
        .optional(),
    })
    .optional(),
  inject: z
    .object({
      retrieval: z
        .object({ forceMode: z.enum(["naive", "mix"]).optional(), mixTimeout: z.boolean().optional(), empty: z.boolean().optional() })
        .optional(),
    })
    .optional(),
  expected: z.record(z.string(), z.string()),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

const PhrasesSchema = z.object({ phrases: z.record(z.string(), z.string()), templates: z.record(z.string(), z.string()) });
export type PhraseLibrary = z.infer<typeof PhrasesSchema>;

function load<T>(file: string, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid mock data in ${file}: ${parsed.error.message}`);
  return parsed.data;
}

export interface MockData {
  readonly policies: readonly Policy[];
  readonly claims: readonly Claim[];
  readonly chunks: readonly DocChunk[];
  readonly relations: readonly z.infer<typeof RelationSchema>[];
  readonly scenarios: readonly Scenario[];
  readonly phrases: PhraseLibrary;
}

export function loadMockData(dataDir = config.dataDir, scenarioFile = config.scenarioFile): MockData {
  const docs = load(path.join(dataDir, "documents.json"), z.object({ chunks: z.array(ChunkSchema), relations: z.array(RelationSchema) }));
  return {
    policies: load(path.join(dataDir, "policies.json"), z.object({ policies: z.array(PolicySchema) })).policies,
    claims: load(path.join(dataDir, "claims.json"), z.object({ claims: z.array(ClaimSchema) })).claims,
    chunks: docs.chunks,
    relations: docs.relations,
    scenarios: load(scenarioFile, z.object({ scenarios: z.array(ScenarioSchema) })).scenarios,
    phrases: load(path.join(dataDir, "phrases.json"), PhrasesSchema),
  };
}
