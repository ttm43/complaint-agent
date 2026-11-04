"""Check rendered clips by transcribing them back with Parakeet and comparing to the script.

    <live-interpreter>/.venv/Scripts/python.exe scripts/voices/qa.py

Prints clips whose word error rate is above the threshold; those should be re-rendered
(delete the wav and run render.py again). This is the one-time QA step for pre-recorded audio.
"""
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf
import yaml

ROOT = Path(__file__).resolve().parents[2]
AUDIO = ROOT / "public" / "audio"
REGISTRY = Path(os.environ.get("MODEL_REGISTRY", ROOT.parent / "models" / "registry.yaml"))
THRESHOLD = 0.08  # character error rate

# Scripts spell things out ("P O L one zero zero two", "A F C A dot org") while ASR writes
# "POL1002" / "afca.org.au". Compare on letters and digits only, with number words as digits.
UNITS = {"zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
         "six": "6", "seven": "7", "eight": "8", "nine": "9"}
TEENS = {"ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14", "fifteen": "15",
         "sixteen": "16", "seventeen": "17", "eighteen": "18", "nineteen": "19"}
TENS = {"twenty": "2", "thirty": "3", "forty": "4", "fifty": "5", "sixty": "6", "seventy": "7", "eighty": "8", "ninety": "9"}
FILLER = {"dot"}


def model_dir(key: str) -> Path:
    reg = yaml.safe_load(REGISTRY.read_text(encoding="utf-8"))
    root = Path(os.environ.get("MODEL_STORE", reg["root"]))
    return root / reg["models"][key]["path"]


def chars(text: str) -> str:
    ws = re.sub(r"[^a-z0-9 ]+", " ", text.lower().replace("-", " ").replace("'", "")).split()
    out: list[str] = []
    for i, w in enumerate(ws):
        if w in FILLER:
            continue
        if w in TENS:
            nxt = ws[i + 1] if i + 1 < len(ws) else ""
            out.append(TENS[w] + ("" if nxt in UNITS else "0"))
        else:
            out.append(UNITS.get(w) or TEENS.get(w) or w)
    return "".join(out)


def wer(ref: str, hyp: str) -> float:
    """Edit distance over characters, divided by the script length."""
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1] / max(1, len(ref))


def main() -> None:
    d = model_dir("sherpa-parakeet-tdt-0.6b-fp32")
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / "encoder.onnx"), decoder=str(d / "decoder.onnx"), joiner=str(d / "joiner.onnx"),
        tokens=str(d / "tokens.txt"), num_threads=4, model_type="nemo_transducer")
    clips = json.loads((ROOT / "var" / "audio-manifest.json").read_text(encoding="utf-8"))["clips"]
    bad, missing = [], []
    for c in clips:
        p = AUDIO / f"{c['id']}.wav"
        if not p.exists():
            missing.append(c)
            continue
        x, sr = sf.read(p, dtype="float32")
        x = x * (0.5 / (float(np.abs(x).max()) or 1.0))
        s = rec.create_stream()
        s.accept_waveform(sr, x)
        rec.decode_stream(s)
        heard = s.result.text.strip()
        score = wer(chars(c["text"]), chars(heard))
        if score > THRESHOLD:
            bad.append((score, c, heard))
    for score, c, heard in sorted(bad, key=lambda b: -b[0]):
        print(f"CER {score:.2f} {c['id']} {c['voice']}\n  script: {c['text']}\n  heard:  {heard}")
    for c in missing:
        print(f"MISSING {c['id']} {c['voice']}: {c['text'][:60]}")
    print(f"{len(clips) - len(bad) - len(missing)} ok, {len(bad)} above CER {THRESHOLD}, {len(missing)} missing")
    sys.exit(1 if bad or missing else 0)


if __name__ == "__main__":
    main()
