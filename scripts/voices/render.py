"""Pre-render every clip in var/audio-manifest.json to public/audio/{id}.wav.

Runs in the voiceclone environment (Qwen3-TTS), which lives in another project:
    npx tsx scripts/audio-manifest.ts > var/audio-manifest.json
    <voiceclone>/.venv-rt/Scripts/python.exe scripts/voices/render.py [--force]

Clips that already exist are skipped, so changing one line only re-renders that line.
The TTS model is resolved through the shared model registry, never by a hard-coded path.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
VOICES = ROOT / "models" / "voices"
OUT = ROOT / "public" / "audio"
VOICECLONE = Path(os.environ.get("VOICECLONE_DIR", ROOT.parent / "live-interpreter" / "voiceclone"))
MODEL_KEY = "qwen3-tts-12hz-1.7b-base"

sys.path.insert(0, str(VOICECLONE))
from clone_zeroshot import build_prompt  # noqa: E402
from paths import default_model_path  # noqa: E402
from voice_tts import VoiceConfig, VoiceTts  # noqa: E402


def slug(voice: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", voice.lower()).strip("-")


def prompt_for(model: str, voice: str, ref_text: str) -> Path:
    ref = VOICES / "refs" / f"{slug(voice)}.wav"
    if not ref.exists():
        raise SystemExit(f"missing {ref}; run scripts/voices/make_refs.py first")
    cache = VOICES / "prompts" / f"{slug(voice)}.pt"
    if not cache.exists():
        print(f"building clone prompt for {voice}", flush=True)
        build_prompt(model, ref, ref_text, "icl", cache)
    return cache


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-render clips that already exist")
    ap.add_argument("--voice", help="only this voice id, e.g. agent")
    args = ap.parse_args()

    cfg = json.loads((VOICES / "voices.json").read_text(encoding="utf-8"))
    ref_text = (VOICES / cfg["sourceText"]).read_text(encoding="utf-8").strip()
    clips = json.loads((ROOT / "var" / "audio-manifest.json").read_text(encoding="utf-8"))["clips"]
    OUT.mkdir(parents=True, exist_ok=True)
    model = default_model_path(MODEL_KEY)

    by_voice: dict[str, list[dict]] = {}
    for c in clips:
        if args.voice and c["voice"] != args.voice:
            continue
        if args.force or not (OUT / f"{c['id']}.wav").exists():
            by_voice.setdefault(c["voice"], []).append(c)

    for voice, todo in by_voice.items():
        if voice not in cfg["voices"]:
            raise SystemExit(f"no voice configured for {voice} in models/voices/voices.json")
        tts = VoiceTts(VoiceConfig(model_path=model, clone_prompt_path=prompt_for(model, voice, ref_text)))
        tts.warmup()
        for c in todo:
            audio, sr = tts.synthesize(c["text"])
            peak = float(np.abs(audio).max()) or 1.0
            sf.write(OUT / f"{c['id']}.wav", (audio * min(1.0, 0.9 / peak)).astype(np.float32), sr, subtype="PCM_16")
            print(f"{voice:24} {len(audio) / sr:5.1f}s  {c['text'][:70]}", flush=True)
        tts.close()
    print(f"done: {sum(len(v) for v in by_voice.values())} rendered, {len(clips)} in manifest")


if __name__ == "__main__":
    main()
