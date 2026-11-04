import type { AppContext } from "../context";
import type { CallEngine } from "../engine/callEngine";
import type { Scenario } from "../mock/data";

export interface RunResult {
  readonly scenarioId: string;
  readonly complaintId: string;
  readonly finalState: string;
  readonly expectedState: string;
  readonly passed: boolean;
  readonly turnsUsed: number;
}

/**
 * Plays a scenario without audio: each customer turn is sent as soon as the agent
 * waits for one. Used by tests and the page's "run all" button.
 */
export async function runScenario(ctx: AppContext, engine: CallEngine, scenario: Scenario, callId: string): Promise<RunResult> {
  const { complaintId } = await engine.start(callId, scenario.id);
  let used = 0;
  for (const t of scenario.turns) {
    if (engine.phase(complaintId) === "ended") break;
    await engine.turn(complaintId, { text: t.asr ?? "", say: t.say, confidence: t.confidence, keypad: t.keypad });
    used += 1;
  }
  const finalState = ctx.complaints.require(complaintId).state;
  const expectedState = scenario.expected["state"] ?? "";
  return { scenarioId: scenario.id, complaintId, finalState, expectedState, passed: finalState === expectedState, turnsUsed: used };
}
