"""Run model preparation on the cloud server, not the desktop."""
import os
from pathlib import Path
import subprocess
import sys

if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
    raise SystemExit("Model setup is restricted to the Linux cloud worker")

from huggingface_hub import snapshot_download

root = os.environ.get("NEXUS_ENGINE_DIR", "/opt/FasterLivePortrait") + "/checkpoints"
snapshot_download("warmshao/FasterLivePortrait", local_dir=root, allow_patterns=["liveportrait_onnx/*.onnx"])
snapshot_download("jdh-algo/JoyVASA", revision="b8f13fe9c23679c56f21b1baafb92ed00dc087c3", local_dir=root + "/JoyVASA", allow_patterns=["motion_generator/motion_generator_hubert_chinese.pt", "motion_template/motion_template.pkl"])
snapshot_download("TencentGameMate/chinese-hubert-base", revision="fce0375452b1dd6c080ac3248d423d4d037bc831", local_dir=root + "/chinese-hubert-base", allow_patterns=["config.json", "preprocessor_config.json", "pytorch_model.bin"])
snapshot_download("KlingTeam/LivePortrait", revision="82a4fa6735ca58432b6ce39301b4b9ee066dea47", local_dir=root, allow_patterns=["liveportrait/base_models/warping_module.pth", "liveportrait/base_models/spade_generator.pth"])
upstream = Path(root).parent / "LivePortrait"
if not upstream.exists():
    subprocess.run(["git", "clone", "https://github.com/KlingTeam/LivePortrait.git", str(upstream)], check=True)
subprocess.run(["git", "-C", str(upstream), "checkout", "9b294b3d0536135442ea73cb01e6cb3ca7029dd3"], check=True)

# PyTorch's new weight-norm names must match before Transformers loads HuBERT.
import torch
hubert = Path(root) / "chinese-hubert-base/pytorch_model.bin"
state = torch.load(hubert, map_location="cpu", weights_only=True)
prefix = "encoder.pos_conv_embed.conv."
if prefix + "weight_g" in state:
    state[prefix + "parametrizations.weight.original0"] = state.pop(prefix + "weight_g")
    state[prefix + "parametrizations.weight.original1"] = state.pop(prefix + "weight_v")
    temporary = hubert.with_suffix(".tmp")
    torch.save(state, temporary)
    temporary.replace(hubert)
