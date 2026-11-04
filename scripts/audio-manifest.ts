// Lists every clip the demo can play, with the same audio ids the backend puts on its events.
//   npx tsx scripts/audio-manifest.ts > var/audio-manifest.json
import { parsePolicyNumber, readBack } from "../src/domain/identity";
import { loadMockData } from "../src/mock/data";
import { audioId, customerVoice, Phrases, type VoiceId } from "../src/phrases";

interface Clip {
  readonly id: string;
  readonly voice: VoiceId;
  readonly text: string;
}

const data = loadMockData();
const phrases = new Phrases(data.phrases);
const clips = new Map<string, Clip>();
const add = (voice: VoiceId, text: string) => {
  const id = audioId(voice, text);
  clips.set(id, { id, voice, text });
};

// Agent: fixed phrases, read-backs of every policy number the scripts can produce, scripted replies.
for (const u of phrases.allFixed()) add("agent", u.text);
const policyNumbers = new Set(data.policies.map((p) => p.policyNumber));
for (const s of data.scenarios) {
  for (const t of s.turns) {
    const parsed = t.asr ? parsePolicyNumber(t.asr) : null;
    if (parsed) policyNumbers.add(parsed);
  }
}
for (const n of policyNumbers) add("agent", phrases.template("CONFIRM_POLICY", { readback: readBack(n) }).text);
for (const s of data.scenarios) if (s.agent?.reply) add("agent", s.agent.reply);

// Customers: what they actually say (not what ASR heard). Keypad turns have no audio.
for (const s of data.scenarios) {
  for (const t of s.turns) if (!t.keypad) add(customerVoice(s.customer.name), t.say);
}

process.stdout.write(`${JSON.stringify({ clips: [...clips.values()] }, null, 2)}\n`);
