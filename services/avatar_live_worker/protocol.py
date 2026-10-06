from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass

STREAM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_HEADER_BYTES = 4096


@dataclass(frozen=True)
class AudioPacket:
    stream_id: str
    sequence: int
    pts_ms: float
    sample_rate: int
    channels: int
    pcm16le: bytes


class ProtocolError(ValueError):
    pass


def decode_audio_packet(message: bytes | bytearray | memoryview) -> AudioPacket:
    raw = bytes(message)
    if len(raw) < 5:
        raise ProtocolError("audio packet is too short")

    (header_length,) = struct.unpack(">I", raw[:4])
    if header_length < 2 or header_length > MAX_HEADER_BYTES:
        raise ProtocolError("invalid audio packet header length")
    if len(raw) < 4 + header_length:
        raise ProtocolError("truncated audio packet header")

    try:
        header = json.loads(raw[4:4 + header_length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("invalid audio packet JSON header") from exc

    if not isinstance(header, dict) or header.get("type") != "AUDIO":
        raise ProtocolError("unsupported data-channel packet")
    stream_id = header.get("streamId")
    sequence = header.get("sequence")
    pts_ms = header.get("ptsMs")
    encoding = header.get("encoding")
    sample_rate = header.get("sampleRate")
    channels = header.get("channels")
    byte_length = header.get("byteLength")

    if not isinstance(stream_id, str) or not STREAM_ID_RE.fullmatch(stream_id):
        raise ProtocolError("invalid audio stream id")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        raise ProtocolError("invalid audio sequence")
    if not isinstance(pts_ms, (int, float)) or isinstance(pts_ms, bool) or pts_ms < 0:
        raise ProtocolError("invalid audio PTS")
    if encoding != "PCM16LE" or sample_rate != 16000 or channels != 1:
        raise ProtocolError("worker accepts mono PCM16LE at 16 kHz only")
    if not isinstance(byte_length, int) or isinstance(byte_length, bool) or byte_length <= 0:
        raise ProtocolError("invalid PCM byte length")

    payload = raw[4 + header_length:]
    if len(payload) != byte_length or len(payload) % 2:
        raise ProtocolError("PCM payload length does not match header")

    return AudioPacket(
        stream_id=stream_id,
        sequence=sequence,
        pts_ms=float(pts_ms),
        sample_rate=sample_rate,
        channels=channels,
        pcm16le=payload,
    )
