import type { AppContext } from "./context";

const DAY = 24 * 60 * 60 * 1000;

/** Two older open complaints so the SLA check has something to flag during the demo. */
export function seedHistoric(ctx: AppContext): void {
  const now = Date.now();
  ctx.complaints.insertHistoric("HIST-0926", new Date(now - 26 * DAY), "HUMAN_HANDLING", "POL-1003", "claim_delay");
  ctx.complaints.insertHistoric("HIST-0904", new Date(now - 29 * DAY), "HUMAN_HANDLING", "POL-1007", "payout_amount");
}
