/** RG 271: final response within 30 calendar days of receiving the complaint. */
export const IDR_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SlaLevel = "ok" | "warn_owner" | "escalate_supervisor" | "overdue";

export interface SlaStatus {
  readonly deadline: string;
  readonly daysLeft: number;
  readonly level: SlaLevel;
}

export function slaStatus(receivedAt: string, now: Date, warnDays = 5, escalateDays = 2): SlaStatus {
  const deadline = new Date(new Date(receivedAt).getTime() + IDR_DAYS * DAY_MS);
  const daysLeft = Math.floor((deadline.getTime() - now.getTime()) / DAY_MS);
  const level: SlaLevel =
    daysLeft < 0 ? "overdue" : daysLeft <= escalateDays ? "escalate_supervisor" : daysLeft <= warnDays ? "warn_owner" : "ok";
  return { deadline: deadline.toISOString(), daysLeft, level };
}
