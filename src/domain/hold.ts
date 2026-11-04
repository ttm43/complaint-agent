/**
 * Hold lines are triggered by the backend the moment a lookup starts, not by the LLM.
 * Schedule: HOLD_1 at once, HOLD_2 after 4 s, then a HOLD_3 every 8 s, handoff at 30 s.
 */
export interface HoldPolicy {
  readonly secondAfterMs: number;
  readonly repeatEveryMs: number;
  readonly giveUpAfterMs: number;
}

export const DEFAULT_HOLD: HoldPolicy = { secondAfterMs: 4000, repeatEveryMs: 8000, giveUpAfterMs: 30000 };

export interface HoldHandle {
  /** Call when the lookup finishes; stops further hold lines. */
  stop(): void;
}

export function startHold(
  say: (phraseId: string) => void,
  onGiveUp: () => void,
  policy: HoldPolicy = DEFAULT_HOLD,
): HoldHandle {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const guard = (fn: () => void) => () => {
    if (!stopped) fn();
  };

  say("HOLD_1");
  timers.push(setTimeout(guard(() => say("HOLD_2")), policy.secondAfterMs));
  for (let t = policy.secondAfterMs + policy.repeatEveryMs; t < policy.giveUpAfterMs; t += policy.repeatEveryMs) {
    timers.push(setTimeout(guard(() => say("HOLD_3")), t));
  }
  timers.push(
    setTimeout(
      guard(() => {
        stopped = true;
        onGiveUp();
      }),
      policy.giveUpAfterMs,
    ),
  );

  return {
    stop() {
      stopped = true;
      timers.forEach(clearTimeout);
    },
  };
}
