"""Add sentence timings to one existing MP3. Never synthesizes or uploads audio.

CPU/GPU inference is an offline tool, deliberately excluded from the API runtime.
The output contains offsets and times, not the book text. Upload alongside the
exact immutable MP3 as <audio-sha256>.sentences-v1.json after reviewing the result.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path


def prepare_sentences(text, normalize=lambda value: value):
    text = " ".join(text.split())
    if not 0 < len(text) <= 600:
        raise ValueError("Expected one speech segment of 1–600 characters")
    sentences = []
    offset = 0
    for match in re.finditer(r'.+?(?:[。！？!?]+(?:\s*[”’」』"\'])*|$)', text):
        original = match.group()
        spoken = normalize(original)
        tokens = []
        for char in spoken:
            if "\u3400" <= char <= "\u9fff":
                tokens.append(char)
            elif not char.isspace() and not unicodedata.category(char).startswith("P"):
                # Do not silently drop English/numbers/symbols and shift every
                # later sentence. A multilingual aligner can be added separately.
                raise ValueError("This aligner requires normalized Mandarin text")
        if not tokens:
            raise ValueError("Sentence has no supported spoken characters")
        end = offset + len(re.sub(r"\s", "", original).encode("utf-16-le")) // 2
        sentences.append({"startOffset": offset, "endOffset": end, "tokens": tokens})
        offset = end
    return text, sentences


def sentence_cues(sentences, timestamps, duration):
    if not math.isfinite(duration) or not 0 < duration <= 600:
        raise ValueError("Invalid audio duration")
    if len(timestamps) != sum(len(sentence["tokens"]) for sentence in sentences):
        raise ValueError("Incomplete timestamp coverage")
    previous = 0
    for start, end in timestamps:
        if not all(isinstance(value, (float, int)) and math.isfinite(value) for value in (start, end)):
            raise ValueError("Invalid timestamp")
        if start < previous or end <= start or end / 1000 > duration + .1:
            raise ValueError("Non-monotonic or out-of-range timestamp")
        previous = end
    cursor = 0
    cues = []
    for sentence in sentences:
        count = len(sentence["tokens"])
        cues.append({"start": timestamps[cursor][0] / 1000,
                     "end": timestamps[cursor + count - 1][1] / 1000,
                     "startOffset": sentence["startOffset"], "endOffset": sentence["endOffset"]})
        cursor += count
    return cues


def align(audio: Path, text: str, *, device="cpu", threads=4):
    # Keep heavy optional dependencies out of backend imports and unit tests.
    import cn2an
    import soundfile
    import torch
    import torchaudio
    from funasr import AutoModel

    if audio.suffix.lower() != ".mp3" or not 0 < audio.stat().st_size <= 12 * 1024 * 1024:
        raise ValueError("Expected the delivered MP3, at most 12 MiB")
    if not 1 <= threads <= 16:
        raise ValueError("threads must be between 1 and 16")
    normalized, sentences = prepare_sentences(text, lambda value: cn2an.transform(value, "an2cn"))
    samples, rate = soundfile.read(audio, dtype="float32")
    duration = len(samples) / rate
    if not 0 < duration <= 600:
        raise ValueError("Audio exceeds the 600 second segment limit")
    waveform = torch.from_numpy(samples)
    if waveform.ndim > 1:
        waveform = waveform.mean(dim=1)
    if rate != 16000:
        waveform = torchaudio.functional.resample(waveform, rate, 16000)
    model = AutoModel(model="fa-zh", model_revision="v2.0.4", device=device,
                      ncpu=threads, disable_update=True, trust_remote_code=False)
    spoken = " ".join(token for sentence in sentences for token in sentence["tokens"])
    result = model.generate(input=(waveform.numpy(), spoken), data_type=("sound", "text"), disable_pbar=True)
    cues = sentence_cues(sentences, result[0]["timestamp"], duration)
    return {"formatVersion": "jojo-speech-sentences/1", "aligner": "funasr-fa-zh/v2.0.4+cn2an-v1",
            "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
            "textSha256": hashlib.sha256(normalized.encode()).hexdigest(), "cues": cues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--text", type=Path, required=True, help="UTF-8 file containing the exact speech segment")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.output.resolve() in {args.audio.resolve(), args.text.resolve()}:
        parser.error("output must not overwrite audio or text")
    result = align(args.audio, args.text.read_text(encoding="utf-8"), device=args.device, threads=args.threads)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"sentences": len(result["cues"]), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
