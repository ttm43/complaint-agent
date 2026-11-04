import { createHash } from "node:crypto";
import type { PhraseLibrary } from "./mock/data";

/** "agent", or "customer:<name>" so each customer keeps their own voice. */
export type VoiceId = "agent" | `customer:${string}`;

export const customerVoice = (name: string): VoiceId => `customer:${name}`;

export interface Utterance {
  readonly phraseId: string | null;
  readonly text: string;
  readonly audioId: string;
}

/** Stable id for a rendered clip: the same voice and text always map to the same file. */
export function audioId(voice: VoiceId, text: string): string {
  return createHash("sha1").update(`${voice}|${text}`).digest("hex").slice(0, 16);
}

export class Phrases {
  constructor(private readonly lib: PhraseLibrary) {}

  fixed(phraseId: string): Utterance {
    const text = this.lib.phrases[phraseId];
    if (text === undefined) throw new Error(`Unknown phrase ${phraseId}`);
    return { phraseId, text, audioId: audioId("agent", text) };
  }

  template(templateId: string, slots: Readonly<Record<string, string>>): Utterance {
    const tpl = this.lib.templates[templateId];
    if (tpl === undefined) throw new Error(`Unknown template ${templateId}`);
    const text = tpl.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = slots[k];
      if (v === undefined) throw new Error(`Template ${templateId} is missing slot ${k}`);
      return v;
    });
    return { phraseId: `${templateId}`, text, audioId: audioId("agent", text) };
  }

  /** Free-form agent text (scripted LLM reply). Pre-rendered for the demo. */
  free(text: string): Utterance {
    return { phraseId: null, text, audioId: audioId("agent", text) };
  }

  allFixed(): Utterance[] {
    return Object.keys(this.lib.phrases).map((id) => this.fixed(id));
  }
}
