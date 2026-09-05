"""Delivery encoding, shared by manual generation and the API. No ffmpeg process."""
from __future__ import annotations

import io
import math
import wave
from dataclasses import dataclass

import lameenc
from mutagen.mp3 import MP3

from .providers import AudioResult

DELIVERY_VERSION = "mp3-48k-mono-lame184-v1"
MAX_AUDIO_BYTES = 12 * 1024 * 1024


@dataclass(frozen=True)
class EncodedAudio:
    data: bytes
    duration: float


def encode_delivery(audio: AudioResult) -> EncodedAudio:
    if not audio.data or len(audio.data) > MAX_AUDIO_BYTES:
        raise ValueError("Audio size exceeds limit")
    if audio.extension == "wav":
        with wave.open(io.BytesIO(audio.data), "rb") as wav:
            if wav.getsampwidth() != 2 or wav.getnchannels() != 1 or wav.getcomptype() != "NONE":
                raise ValueError("Expected mono PCM16 WAV")
            encoder = lameenc.Encoder()
            encoder.set_bit_rate(48)
            encoder.set_in_sample_rate(wav.getframerate())
            encoder.set_channels(1)
            encoder.set_quality(2)
            encoder.silence()
            data = bytes(encoder.encode(wav.readframes(wav.getnframes())) + encoder.flush())
    elif audio.extension == "mp3":
        data = audio.data
    else:
        raise ValueError("Unsupported audio format")
    duration = MP3(io.BytesIO(data)).info.length
    if not math.isfinite(duration) or not 0 < duration <= 600:
        raise ValueError("Invalid audio duration")
    return EncodedAudio(data, duration)
