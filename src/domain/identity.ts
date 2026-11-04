const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
const SPOKEN_DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * Pull a policy number out of ASR text. Accepts "POL1002", "POL-1002" and
 * "P O L one zero zero two". Returns "POL-1002" or null when the format is wrong.
 */
export function parsePolicyNumber(asrText: string): string | null {
  const compact = asrText.toUpperCase().match(/\bP\s*O\s*L\s*-?\s*(\d{4})\b/);
  if (compact?.[1]) return `POL-${compact[1]}`;

  const words = asrText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const start = words.findIndex((w, i) => w === "pol" || (w === "p" && words[i + 1] === "o" && words[i + 2] === "l"));
  if (start < 0) return null;
  const after = words.slice(start + (words[start] === "pol" ? 1 : 3));
  const digits = after.map((w) => DIGIT_WORDS[w] ?? (/^\d$/.test(w) ? w : null)).filter((d): d is string => d !== null);
  return digits.length === 4 ? `POL-${digits.join("")}` : null;
}

/** Keypad entry is four digits; anything else is rejected. */
export function parseKeypad(digits: string): string | null {
  return /^\d{4}$/.test(digits) ? `POL-${digits}` : null;
}

/** "POL-1002" -> "P O L one zero zero two", so the read-back is unambiguous on the phone. */
export function readBack(policyNumber: string): string {
  const digits = policyNumber.replace(/\D/g, "").split("");
  return `P O L ${digits.map((d) => SPOKEN_DIGITS[Number(d)]).join(" ")}`;
}

/** A real calendar date in the past, ISO yyyy-mm-dd. */
export function isValidDob(iso: string, now: Date): boolean {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  const sameDate = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
  return sameDate && d.getTime() < now.getTime();
}

const YES = /\b(yes|yeah|yep|correct|that's right|right|sure|okay|ok|fine|suppose so|i guess)\b/i;
const NO = /\b(no|nope|not|wrong|isn't)\b/i;

export function isAffirmative(text: string): boolean {
  return YES.test(text) && !NO.test(text);
}
