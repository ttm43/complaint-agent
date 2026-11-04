import { CATEGORIES, type Category } from "../domain/types";

// Keyword rules standing in for the fine-tuned BERT classifier and the risk detector.
// Same interface as the real models: text in, labels with probabilities out.

export interface Classification {
  readonly category: Category;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Category, number>>;
}

const WEIGHTS: Readonly<Record<Category, ReadonlyArray<readonly [RegExp, number]>>> = {
  claim_delay: [
    [/\bwaiting\b/i, 2], [/\bweeks?\b/i, 1], [/\bnobody\b|\bno one\b/i, 1.5], [/\bassess/i, 1.5],
    [/\bopen for\b/i, 1.5], [/\bwould take\b|\btaking (so )?long\b/i, 1], [/\bmonths?\b/i, 0.5],
  ],
  claim_denial: [[/\bdeclined\b|\bdenied\b|\brejected\b/i, 3], [/\bpolice report\b/i, 1.5], [/\brefused\b/i, 2]],
  payout_amount: [[/\bpayout\b|\bpaid out\b/i, 3], [/\boffer(ed)?\b/i, 2], [/\bworth\b/i, 2], [/\bnot enough\b/i, 1.5], [/\bamount\b/i, 1.5]],
  repair_quality: [
    [/\bnoise\b|\bgrinding\b|\brattl/i, 2.5], [/\bnot fixed\b|\bbadly\b|\bworkmanship\b/i, 2.5], [/\brepaired\b/i, 1], [/\brepairer\b/i, 0.5],
  ],
};

export function classify(text: string): Classification {
  const scores = CATEGORIES.map((c) => WEIGHTS[c].reduce((s, [re, w]) => s + (re.test(text) ? w : 0), 0));
  const exps = scores.map((s) => Math.exp(s));
  const total = exps.reduce((a, b) => a + b, 0);
  const probs = Object.fromEntries(CATEGORIES.map((c, i) => [c, round((exps[i] ?? 0) / total)])) as Record<Category, number>;
  const best = CATEGORIES.reduce((a, b) => (probs[b] > probs[a] ? b : a));
  return { category: best, confidence: probs[best], probabilities: probs };
}

export type RiskType = "financial_hardship" | "vulnerability" | "self_harm";

export interface RiskSignal {
  readonly type: RiskType;
  readonly confidence: number;
  readonly matched: string;
}

const RISK_RULES: ReadonlyArray<readonly [RiskType, RegExp, number]> = [
  ["self_harm", /\b(end it all|can'?t go on|hurt myself)\b/i, 0.95],
  ["financial_hardship", /\b(lose my job|can'?t get to work|can'?t afford|behind on (rent|bills))\b/i, 0.88],
  ["vulnerability", /\b(disabilit\w*|family violence|domestic violence|carer for)\b/i, 0.85],
];

/** Runs on every customer sentence. Thresholds are kept low on purpose: a false alarm costs less than a miss. */
export function detectRisk(text: string): RiskSignal | null {
  for (const [type, re, confidence] of RISK_RULES) {
    const m = text.match(re);
    if (m) return { type, confidence, matched: m[0] };
  }
  return null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Mock of the LLM's slot extraction: "12 April 1990" -> "1990-04-12". */
export function extractDob(asrText: string): string | null {
  const m = asrText.toLowerCase().match(/\b(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2] ?? "");
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
