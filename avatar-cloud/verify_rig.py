"""Verify that the exported GLB contains a skin and changing joint tracks."""
import json
from pathlib import Path
import struct
import sys


def verify(path, action):
    data = Path(path).read_bytes()
    if len(data) < 20 or struct.unpack_from("<4sII", data) != (b"glTF", 2, len(data)):
        raise ValueError("Invalid GLB header")
    json_size, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A:
        raise ValueError("Missing GLB JSON chunk")
    document = json.loads(data[20:20 + json_size])
    binary_offset = 20 + json_size
    binary_size, kind = struct.unpack_from("<II", data, binary_offset)
    if kind != 0x004E4942 or binary_offset + 8 + binary_size != len(data):
        raise ValueError("Invalid GLB binary chunk")
    binary = data[binary_offset + 8:]
    skins = document.get("skins", [])
    if not skins or not any(len(skin["joints"]) >= 27 for skin in skins):
        raise ValueError("Export lacks the full 27-joint skeleton")
    nodes = document["nodes"]
    if not any("skin" in node and "mesh" in node for node in nodes):
        raise ValueError("Export lacks a skinned character mesh")
    required = {
        "idle": {"head", "spine"},
        "wave": {"head", "upper_arm.L", "forearm.L", "hand.L"},
        "walk": {"head", "thigh.L", "thigh.R", "calf.L", "calf.R"},
        "showcase": {"head", "upper_arm.L", "hand.L", "thigh.L", "thigh.R", "calf.L", "calf.R"},
    }
    if action not in required:
        raise ValueError("Unknown rig action")
    moving = set()
    for animation in document.get("animations", []):
        for channel in animation["channels"]:
            if channel["target"]["path"] != "rotation":
                continue
            name = nodes[channel["target"]["node"]].get("name")
            sampler = animation["samplers"][channel["sampler"]]
            accessor = document["accessors"][sampler["output"]]
            if accessor["componentType"] != 5126 or accessor["type"] != "VEC4":
                raise ValueError("Expected float quaternion joint track")
            view = document["bufferViews"][accessor["bufferView"]]
            offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            stride = view.get("byteStride", 16)
            quaternions = [struct.unpack_from("<4f", binary, offset + i * stride)
                           for i in range(accessor["count"])]
            if quaternions and any(max(abs(a - b) for a, b in zip(quaternions[0], value)) > .01
                                   for value in quaternions[1:]):
                moving.add(name)
    missing = required[action] - moving
    if missing:
        raise ValueError("Required joints have no changing exported rotation: " + ", ".join(sorted(missing)))
    return {"skins": len(skins), "movingJoints": sorted(moving), "action": action}


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1], sys.argv[2]), indent=2))
