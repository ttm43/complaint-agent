import type { ActionRequest, Category, RetrievedChunk } from "../domain/types";
import type { MockData, Scenario } from "./data";

// Stand-in for the conversational LLM with tool calling. In production this is a
// prompt plus tools; here each scenario scripts what the model would return, so the
// demo is repeatable. The backend still validates every proposed action.

export interface Resolution {
  readonly reply: string;
  readonly action: ActionRequest | null;
}

export interface ResolutionInput {
  readonly scenarioId: string | null;
  readonly category: Category;
  readonly retrieved: readonly RetrievedChunk[];
}

export class ScriptedLlm {
  private readonly byId: ReadonlyMap<string, Scenario>;

  constructor(data: MockData) {
    this.byId = new Map(data.scenarios.map((s) => [s.id, s]));
  }

  /** Which claim the customer is talking about (the real model infers it from the conversation). */
  pickClaim(scenarioId: string | null, claimIds: readonly string[]): string | null {
    const scripted = scenarioId ? this.byId.get(scenarioId)?.agent?.claimId : undefined;
    if (scripted && claimIds.includes(scripted)) return scripted;
    return claimIds[0] ?? null;
  }

  resolve(input: ResolutionInput): Resolution {
    const agent = input.scenarioId ? this.byId.get(input.scenarioId)?.agent : undefined;
    if (!agent?.reply || !agent.action) {
      return { reply: "", action: null };
    }
    return {
      reply: agent.reply,
      action: { type: agent.action.type, citations: agent.action.citations, params: agent.action.params, customerText: agent.reply },
    };
  }
}
