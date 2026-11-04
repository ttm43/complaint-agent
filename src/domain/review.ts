import type { Category } from "./types";

export type ReviewMode = "full" | "sample";

export interface CategoryStats {
  readonly category: Category;
  readonly reviewed: number;
  readonly misclassified: number;
  readonly wrongCitation: number;
  readonly mode: ReviewMode;
}

/** 95% upper bound of the error rate: rule of three with no errors, Wilson otherwise. */
export function errorUpperBound(reviewed: number, errors: number): number {
  if (reviewed === 0) return 1;
  if (errors === 0) return Math.min(1, 3 / reviewed);
  const z = 1.96;
  const p = errors / reviewed;
  const denom = 1 + (z * z) / reviewed;
  const centre = p + (z * z) / (2 * reviewed);
  const margin = z * Math.sqrt((p * (1 - p)) / reviewed + (z * z) / (4 * reviewed * reviewed));
  return Math.min(1, (centre + margin) / denom);
}

export interface ReviewEvaluation {
  readonly upperBound: number;
  readonly mode: ReviewMode;
}

/** A category moves to sampling only once its upper bound is below target. */
export function evaluate(stats: CategoryStats, target: number): ReviewEvaluation {
  const upperBound = errorUpperBound(stats.reviewed, stats.misclassified + stats.wrongCitation);
  return { upperBound, mode: upperBound < target ? "sample" : "full" };
}

export interface SilentError {
  readonly kind: "misclassified" | "wrongCitation";
}

/** A silent error is counted, and the category drops back to full review at once. */
export function recordSilentError(stats: CategoryStats, error: SilentError): CategoryStats {
  return {
    ...stats,
    reviewed: stats.reviewed,
    misclassified: stats.misclassified + (error.kind === "misclassified" ? 1 : 0),
    wrongCitation: stats.wrongCitation + (error.kind === "wrongCitation" ? 1 : 0),
    mode: "full",
  };
}

/** Sample rate never drops to zero. */
export function sampleRate(mode: ReviewMode, configured: number, floor = 0.05): number {
  return mode === "full" ? 1 : Math.max(floor, configured);
}
