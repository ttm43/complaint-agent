"""Make one reference clip per role from the user's recording (needs praat-parselmouth).
    python scripts/voices/make_refs.py
pitchMedian 0 keeps the original voice unchanged."""
import json
import re
import shutil
from pathlib import Path

import parselmouth
from parselmouth.praat import call

ROOT = Path(__file__).resolve().parents[2]
VOICES = ROOT / "models" / "voices"


def slug(voice: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", voice.lower()).strip("-")


def main() -> None:
    cfg = json.loads((VOICES / "voices.json").read_text(encoding="utf-8"))
    src = VOICES / cfg["source"]
    for voice, v in cfg["voices"].items():
        out = VOICES / "refs" / f"{slug(voice)}.wav"
        if v["pitchMedian"] == 0:
            shutil.copyfile(src, out)
        else:
            snd = parselmouth.Sound(str(src))
            call(snd, "Change gender", 75, 400, v["formantRatio"], v["pitchMedian"], 1.0, 1.0).save(str(out), "WAV")
        print("ref", voice, "->", out.name)


if __name__ == "__main__":
    main()
