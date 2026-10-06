import json
import struct
import unittest

from protocol import ProtocolError, decode_audio_packet


def packet(header, pcm=b"\x00\x01\x02\x03"):
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(encoded)) + encoded + pcm


class ProtocolTests(unittest.TestCase):
    def test_valid_pcm_packet(self):
        value = decode_audio_packet(packet({
            "type": "AUDIO",
            "streamId": "abc_123",
            "sequence": 0,
            "ptsMs": 12.5,
            "encoding": "PCM16LE",
            "sampleRate": 16000,
            "channels": 1,
            "byteLength": 4,
        }))
        self.assertEqual(value.stream_id, "abc_123")
        self.assertEqual(value.sequence, 0)
        self.assertEqual(value.pts_ms, 12.5)
        self.assertEqual(value.pcm16le, b"\x00\x01\x02\x03")

    def test_rejects_bad_length_and_format(self):
        base = {
            "type": "AUDIO",
            "streamId": "stream",
            "sequence": 0,
            "ptsMs": 0,
            "encoding": "PCM16LE",
            "sampleRate": 16000,
            "channels": 1,
            "byteLength": 4,
        }
        bad = [
            {**base, "byteLength": 2},
            {**base, "encoding": "WAV"},
            {**base, "sampleRate": 48000},
            {**base, "channels": 2},
            {**base, "streamId": "../bad"},
            {**base, "sequence": -1},
            {**base, "ptsMs": -1},
        ]
        for header in bad:
            with self.subTest(header=header):
                with self.assertRaises(ProtocolError):
                    decode_audio_packet(packet(header))

    def test_rejects_truncated_header(self):
        with self.assertRaises(ProtocolError):
            decode_audio_packet(struct.pack(">I", 100) + b"{}")


if __name__ == "__main__":
    unittest.main()
