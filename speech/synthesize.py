import argparse
import json
import wave
import sys
from pathlib import Path

import onnxruntime
from piper import PiperVoice
from piper.config import PiperConfig


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("text_file", nargs="?")
    parser.add_argument("audio_file", nargs="?")
    args = parser.parse_args()
    model = Path(args.model)
    config = PiperConfig.from_dict(json.loads(Path(str(model) + ".json").read_text(encoding="utf-8")))
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    voice = PiperVoice(
        session=onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"]),
        config=config,
    )
    def synthesize(text_file, audio_file):
        text = Path(text_file).read_text(encoding="utf-8").strip()
        if not text or len(text) > 6000:
            raise ValueError("Speech text must contain 1 to 6000 characters.")
        with wave.open(audio_file, "wb") as audio:
            voice.synthesize_wav(text, audio)

    if args.worker:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                synthesize(request["textFile"], request["audioFile"])
                print(json.dumps({"ok": True}), flush=True)
            except (ValueError, KeyError, OSError, RuntimeError) as error:
                print(json.dumps({"ok": False, "errorType": type(error).__name__}), flush=True)
    else:
        synthesize(args.text_file, args.audio_file)


if __name__ == "__main__":
    main()
