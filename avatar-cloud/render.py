"""Run only inside the remote worker, never on the user's Windows desktop."""
import argparse
import collections
import importlib
import importlib.util
import os
from pathlib import Path
import pickle
import shutil
import subprocess
import sys
import types


def torch_warper(engine):
    import torch
    from omegaconf import OmegaConf
    upstream = engine / "LivePortrait"
    spec = importlib.util.spec_from_file_location(
        "nexus_liveportrait_modules", upstream / "src/modules/__init__.py",
        submodule_search_locations=[str(upstream / "src/modules")],
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    WarpingNetwork = importlib.import_module(spec.name + ".warping_network").WarpingNetwork
    SPADEDecoder = importlib.import_module(spec.name + ".spade_generator").SPADEDecoder
    params = OmegaConf.load(upstream / "src/config/models.yaml").model_params

    class TorchWarpingSpade:
        def __init__(self, **kwargs):
            if not torch.cuda.is_available():
                raise RuntimeError("Cloud CUDA GPU is required for portrait warping")
            self.device = torch.device("cuda")
            self.warp = WarpingNetwork(**params.warping_module_params)
            self.decoder = SPADEDecoder(**params.spade_generator_params)
            weights = engine / "checkpoints/liveportrait/base_models"
            for model, name in ((self.warp, "warping_module"), (self.decoder, "spade_generator")):
                model.load_state_dict(torch.load(weights / (name + ".pth"), map_location="cpu", weights_only=True))
                model.to(self.device).eval()

        @torch.inference_mode()
        def predict(self, feature, source, driving):
            feature, source, driving = [
                torch.as_tensor(value, device=self.device, dtype=torch.float32)
                for value in (feature, source, driving)
            ]
            warped = self.warp(feature, kp_driving=driving, kp_source=source)["out"]
            result = self.decoder(warped).permute(0, 2, 3, 1).clamp(0, 1) * 255
            return result[0]

    return TorchWarpingSpade


def verify_video(video):
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", video], check=True, capture_output=True, text=True)
    if not {"audio", "video"}.issubset(set(probe.stdout.splitlines())):
        raise RuntimeError("Rendered video must contain both animated video and speech")
    import cv2
    import numpy as np
    capture = cv2.VideoCapture(video)
    try:
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        ok, first = capture.read()
        if not ok or count < 2:
            raise RuntimeError("Rendered video has no readable animation frames")
        changed = False
        for position in (count // 3, count // 2, count - 1):
            capture.set(cv2.CAP_PROP_POS_FRAMES, position)
            ok, frame = capture.read()
            if ok and float(np.mean(cv2.absdiff(first, frame))) > 0.1:
                changed = True
        if not changed:
            raise RuntimeError("Rendered video is static; animation was not verified")
    finally:
        capture.release()


def main():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Rendering is restricted to the cloud worker")
    job = Path(sys.argv[1]).resolve()
    engine = Path(os.environ.get("NEXUS_ENGINE_DIR", "/opt/FasterLivePortrait"))
    os.chdir(engine)
    sys.path.insert(0, str(engine))
    os.environ["MPLBACKEND"] = "Agg"
    import torch
    from omegaconf import OmegaConf
    from src.pipelines.gradio_live_portrait_pipeline import GradioLivePortraitPipeline
    from src.pipelines import joyvasa_audio_to_motion_pipeline as joy
    from src import models
    # Stock ONNX Runtime cannot execute the renderer's 5D GridSample.
    models.WarpingSpadeModel = torch_warper(engine)

    # The upstream checkpoint includes Namespace/PosixPath metadata; allow only
    # the known tensor rebuilding globals, not arbitrary pickle execution.
    allowed = {
        ("argparse", "Namespace"): argparse.Namespace,
        ("pathlib", "PosixPath"): Path,
        ("collections", "OrderedDict"): collections.OrderedDict,
        ("torch._utils", "_rebuild_tensor_v2"): torch._utils._rebuild_tensor_v2,
        ("torch", "FloatStorage"): torch.FloatStorage,
        ("torch", "BoolStorage"): torch.BoolStorage,
    }

    class RestrictedUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if (module, name) not in allowed:
                raise pickle.UnpicklingError(f"Blocked model global: {module}.{name}")
            return allowed[(module, name)]

    safe_pickle = types.ModuleType("nexus_safe_pickle")
    safe_pickle.Unpickler = RestrictedUnpickler
    original_load = torch.load

    def safe_load(path, *args, **kwargs):
        if Path(path).resolve() == (engine / "checkpoints/JoyVASA/motion_generator/motion_generator_hubert_chinese.pt").resolve():
            kwargs["pickle_module"] = safe_pickle
        return original_load(path, *args, **kwargs)

    joy.torch.load = safe_load
    audio = job / "speech.wav"
    subprocess.run(["espeak-ng", "-v", "pl", "-s", "150", "-f", str(job / "script.txt"), "-w", str(audio)], check=True, timeout=60)
    config = OmegaConf.load(engine / "configs/onnx_infer.yaml")
    for path in (config.joyvasa_models.motion_model_path, config.joyvasa_models.audio_model_path, config.joyvasa_models.motion_template_path):
        if not Path(path).exists():
            raise FileNotFoundError(f"Required model missing: {path}")
    pipeline = GradioLivePortraitPipeline(config)
    portraits = list(job.glob("portrait.*"))
    if len(portraits) != 1:
        raise ValueError("Expected exactly one source portrait")
    video, _, _ = pipeline.run_audio_driving(str(audio), str(portraits[0]), save_dir=str(job / "render"))
    verify_video(video)
    shutil.copy2(video, job / "video.mp4")


if __name__ == "__main__":
    main()
