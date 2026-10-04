"""Composite one unified character output over an independent background."""
import numpy as np


def compose_scene_frame(character, background, matte):
    actor = np.asarray(character)
    scene = np.asarray(background)
    alpha = np.asarray(matte)
    if (
        actor.ndim != 3 or actor.shape[2] != 3
        or scene.shape != actor.shape
        or alpha.shape != actor.shape[:2]
    ):
        raise ValueError("Character/background must be matching RGB frames with a same-size single-channel matte")
    if any(pixels.dtype != np.uint8 for pixels in (actor, scene, alpha)):
        raise ValueError("Scene inputs must be uint8; matte 0 is background and 255 is character")
    opacity = alpha[:, :, None].astype(np.float32) / 255
    result = np.rint(actor * opacity + scene * (1 - opacity)).astype(np.uint8)
    if not np.array_equal(result[alpha == 255], actor[alpha == 255]):
        raise RuntimeError("Opaque character pixels changed during scene composition")
    return result
