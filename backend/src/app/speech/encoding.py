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


class PcmMp3Encoder:
    """Incremental encoding with the same delivery settings as existing WAVs."""

    def __init__(self, sample_rate: int = 24000):
        self.encoder = lameenc.Encoder()
        self.encoder.set_bit_rate(48)
        self.encoder.set_in_sample_rate(sample_rate)
        self.encoder.set_channels(1)
        self.encoder.set_quality(2)
        self.encoder.silence()
        self.pending = b""
        self.received = 0

    def encode(self, pcm: bytes) -> bytes:
        self.received += len(pcm)
        if self.received > MAX_AUDIO_BYTES:
            raise ValueError("Audio size exceeds limit")
        pcm = self.pending + pcm
        length = len(pcm) // 2 * 2
        self.pending = pcm[length:]
        return bytes(self.encoder.encode(pcm[:length])) if length else b""

    def finish(self) -> bytes:
        if self.pending or not self.received:
            raise ValueError("Incomplete PCM16 audio")
        return bytes(self.encoder.flush())


def encode_delivery(audio: AudioResult, *, max_bytes: int | None = MAX_AUDIO_BYTES) -> EncodedAudio:
    if not audio.data or (max_bytes is not None and len(audio.data) > max_bytes):
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
