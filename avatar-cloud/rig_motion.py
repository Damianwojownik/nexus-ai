"""Deterministic skeletal motion; no Blender or inference imports."""
import math


def settings(value):
    if not isinstance(value, dict):
        raise ValueError("Rig settings must be an object")
    allowed = {"camera", "action", "fps", "seconds", "width", "height"}
    if set(value) - allowed:
        raise ValueError("Unknown rig setting")
    result = {"camera": "body", "action": "showcase", "fps": 12, "seconds": 6,
              "width": 384, "height": 512, **value}
    if result["camera"] not in ("body", "face"):
        raise ValueError("Camera must be body or face")
    if result["action"] not in ("idle", "wave", "walk", "showcase"):
        raise ValueError("Action must be idle, wave, walk or showcase")
    for name, low, high in (("fps", 12, 30), ("seconds", 4, 10),
                            ("width", 256, 768), ("height", 256, 768)):
        number = result[name]
        if type(number) is not int or not low <= number <= high:
            raise ValueError(f"{name} must be an integer in {low}..{high}")
    if result["width"] % 2 or result["height"] % 2:
        raise ValueError("Video dimensions must be even")
    return result


def pose(time, action="showcase"):
    if not math.isfinite(time) or time < 0:
        raise ValueError("Motion time must be finite and non-negative")
    if action not in ("idle", "wave", "walk", "showcase"):
        raise ValueError("Unknown motion action")
    wave = action == "wave" or (action == "showcase" and time < 3)
    walk = action == "walk" or (action == "showcase" and time >= 3)
    phase = 2 * math.pi * time
    envelope = min(1, time / .6)
    if action == "showcase":
        envelope *= max(0, min(1, (3 - time) / .6))
    walk_time = time - 3 if action == "showcase" else time
    walk_blend = min(1, max(0, walk_time / .6)) if walk else 0
    joints = {
        "spine": (.025 * math.sin(phase / 3), 0, 0),
        "head": (.055 * math.sin(phase / 4), .16 * math.sin(phase / 5), 0),
    }
    for side, offset in (("L", 0), ("R", math.pi)):
        step = math.sin(2 * math.pi * walk_time * .8 + offset) * walk_blend
        joints["upper_arm." + side] = (-.22 * step, 0, 0)
        joints["forearm." + side] = (-.15 * walk_blend, 0, 0)
        joints["thigh." + side] = (.38 * step, 0, 0)
        joints["calf." + side] = (.65 * max(0, -step), 0, 0)
        joints["hand." + side] = (0, 0, 0)
        for finger in range(5):
            joints[f"finger{finger}.{side}"] = (.3 - .18 * envelope if wave and side == "L" else .3, 0, 0)
    if wave:
        joints["upper_arm.L"] = (0, 0, -1.15 * envelope)
        joints["forearm.L"] = (0, 0, -1.6 * envelope)
        joints["hand.L"] = (0, 0, .25 * math.sin(phase * 1.4) * envelope)
    blink_phase = time % 2.6
    blink = max(0, 1 - abs(blink_phase - 1.5) / .12)
    return {"joints": joints, "rootZ": .012 * math.sin(phase * 1.6) * walk_blend,
            "blink": blink}
