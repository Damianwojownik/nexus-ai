"""A stylized procedural prototype, not a reconstruction of a photo."""
import array
import json
import math
import os
from pathlib import Path
import sys
import wave


def main():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Blender rendering is restricted to the cloud worker")
    import bpy
    from mathutils import Vector
    sys.path.insert(0, str(Path(__file__).parent))
    from rig_motion import settings, pose

    arguments = sys.argv[sys.argv.index("--") + 1:]
    if len(arguments) not in (1, 2) or (len(arguments) == 2 and arguments[1] != "--still"):
        raise ValueError("Usage: blender --python blender_rig.py -- JOB [--still]")
    job = Path(arguments[0]).resolve()
    still = len(arguments) == 2
    config = settings(json.loads((job / "rig.json").read_text(encoding="utf-8")))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    # The distro Blender in Colab is built without OpenImageDenoiser.
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 2
    scene.render.resolution_x, scene.render.resolution_y = config["width"], config["height"]
    scene.render.resolution_percentage = 100
    scene.render.fps = config["fps"]
    scene.frame_start, scene.frame_end = 1, config["fps"] * config["seconds"]
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.filepath = str(job / "rig-silent.mp4")
    scene.world.color = (.025, .04, .08)

    def material(name, color, metallic=0, glow=False):
        result = bpy.data.materials.new(name)
        result.diffuse_color = (*color, 1)
        result.use_nodes = True
        shader = result.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Metallic"].default_value = metallic
        shader.inputs["Roughness"].default_value = .45
        if glow:
            emission = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
            emission.default_value = (*color, 1)
            shader.inputs["Emission Strength"].default_value = 2
        return result

    skin = material("Skin", (.62, .33, .22))
    hoodie = material("Navy hoodie", (.015, .028, .07))
    pants = material("Dark trousers", (.025, .035, .06))
    hair = material("Brown hair", (.035, .018, .012))
    neon = material("Blue luminous trim", (.01, .42, 1), glow=True)
    white = material("Eyes", (.9, .94, 1))
    iris = material("Blue irises", (.015, .2, .55))
    dark = material("Pupils and mouth", (.008, .006, .012))
    lip = material("Lips", (.4, .12, .1))
    character = []

    bones = {
        "root": ((0, 0, .05), (0, 0, .25), None),
        "pelvis": ((0, 0, .91), (0, 0, 1.04), "root"),
        "spine": ((0, 0, 1.04), (0, 0, 1.35), "pelvis"),
        "neck": ((0, 0, 1.35), (0, 0, 1.47), "spine"),
        "head": ((0, 0, 1.47), (0, 0, 1.85), "neck"),
    }
    for side, sign in (("L", 1), ("R", -1)):
        bones.update({
            "upper_arm." + side: ((sign * .25, 0, 1.33), (sign * .32, 0, 1.06), "spine"),
            "forearm." + side: ((sign * .32, 0, 1.06), (sign * .35, 0, .82), "upper_arm." + side),
            "hand." + side: ((sign * .35, 0, .82), (sign * .35, 0, .74), "forearm." + side),
            "thigh." + side: ((sign * .115, 0, .94), (sign * .115, 0, .53), "pelvis"),
            "calf." + side: ((sign * .115, 0, .53), (sign * .115, 0, .13), "thigh." + side),
            "foot." + side: ((sign * .115, 0, .13), (sign * .115, -.16, .08), "calf." + side),
        })
        for finger in range(5):
            x = sign * .35 + (finger - 2) * .017
            bones[f"finger{finger}.{side}"] = ((x, -.007, .75), (x, -.007, .66 + .015 * abs(finger - 2)), "hand." + side)
    armature = bpy.data.armatures.new("NexusSkeleton")
    rig = bpy.data.objects.new("NexusRig", armature)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, parent) in bones.items():
        bone = armature.edit_bones.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = armature.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")

    def sphere(name, center, scale, surface, bone=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, location=center)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.data.materials.append(surface)
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        if bone:
            group = obj.vertex_groups.new(name=bone)
            group.add(list(range(len(obj.data.vertices))), 1, "REPLACE")
            modifier = obj.modifiers.new("Skeletal skin", "ARMATURE")
            modifier.object = rig
            obj.parent = rig
            character.append(obj)
        return obj

    def segment(name, start, end, radius, surface, bone):
        start, end = Vector(start), Vector(end)
        obj = sphere(name, (start + end) / 2, (radius, radius, (end - start).length / 2 + radius * .4), surface, bone)
        obj.rotation_euler = (end - start).to_track_quat("Z", "Y").to_euler()
        return obj

    sphere("Hoodie torso", (0, 0, 1.19), (.245, .135, .24), hoodie, "spine")
    sphere("Hood collar", (0, .025, 1.4), (.19, .14, .08), hoodie, "neck")
    sphere("Neon collar", (0, -.04, 1.41), (.16, .1, .012), neon, "neck")
    sphere("Pelvis trousers", (0, 0, .96), (.19, .125, .13), pants, "pelvis")
    sphere("Neck", (0, 0, 1.46), (.07, .07, .09), skin, "neck")
    sphere("Head", (0, -.012, 1.66), (.155, .132, .195), skin, "head")
    sphere("Hair cap", (0, .01, 1.79), (.165, .14, .115), hair, "head")
    for index in range(7):
        sphere("Hair fringe", ((index - 3) * .037, -.111, 1.79 - .022 * math.sin(index)),
               (.045, .028, .065), hair, "head")
    eyes = []
    for sign in (-1, 1):
        sphere("Ear", (sign * .151, -.006, 1.65), (.024, .022, .047), skin, "head")
        eyes.append(sphere("Eye white", (sign * .06, -.134, 1.695), (.036, .016, .022), white, "head"))
        eyes.append(sphere("Iris", (sign * .06, -.149, 1.695), (.014, .006, .016), iris, "head"))
        eyes.append(sphere("Pupil", (sign * .06, -.154, 1.695), (.007, .003, .011), dark, "head"))
        sphere("Brow", (sign * .062, -.13, 1.735), (.042, .012, .009), hair, "head")
    sphere("Nose", (0, -.147, 1.65), (.022, .028, .037), skin, "head")
    mouth = sphere("Mouth energy opening", (0, -.138, 1.594), (.041, .008, .005), dark, "head")
    sphere("Upper lip", (0, -.141, 1.606), (.046, .008, .005), lip, "head")
    for side, sign in (("L", 1), ("R", -1)):
        for part, radius, surface in (("upper_arm", .073, hoodie), ("forearm", .058, hoodie),
                                      ("thigh", .085, pants), ("calf", .064, pants)):
            head, tail, _ = bones[part + "." + side]
            segment(part + "." + side, head, tail, radius, surface, part + "." + side)
        sphere("Neon cuff", (sign * .35, 0, .83), (.061, .062, .015), neon, "forearm." + side)
        sphere("Hand palm", (sign * .35, 0, .775), (.043, .026, .052), skin, "hand." + side)
        for finger in range(5):
            name = f"finger{finger}.{side}"
            segment(name, bones[name][0], bones[name][1], .009, skin, name)
        sphere("Trainer", (sign * .115, -.065, .065), (.085, .155, .064), hoodie, "foot." + side)
        sphere("Blue sole", (sign * .115, -.07, .018), (.088, .158, .012), neon, "foot." + side)

    with wave.open(str(job / "speech.wav"), "rb") as speech:
        if speech.getsampwidth() != 2 or speech.getnchannels() != 1:
            raise ValueError("Rig mouth timing expects mono PCM16 speech")
        samples = array.array("h", speech.readframes(speech.getnframes()))
        if sys.byteorder != "little":
            samples.byteswap()
        rate = speech.getframerate()
    energy = []
    for frame in range(scene.frame_end):
        start, end = int(frame * rate / config["fps"]), int((frame + 1) * rate / config["fps"])
        part = samples[start:end]
        energy.append(math.sqrt(sum(value * value for value in part) / len(part)) if part else 0)
    peak = max(energy)
    if peak <= 0:
        raise ValueError("Speech contains no measurable sound")
    for frame in range(1, scene.frame_end + 1):
        time = (frame - 1) / config["fps"]
        state = pose(time, config["action"])
        for bone in rig.pose.bones:
            bone.rotation_mode = "XYZ"
            bone.rotation_euler = state["joints"].get(bone.name, (0, 0, 0))
            bone.keyframe_insert(data_path="rotation_euler", frame=frame)
        rig.location.z = state["rootZ"]
        rig.keyframe_insert(data_path="location", frame=frame)
        mouth.scale.z = 1 + 3 * energy[frame - 1] / peak
        mouth.keyframe_insert(data_path="scale", frame=frame)
        for eye in eyes:
            eye.scale.z = max(.04, 1 - state["blink"])
            eye.keyframe_insert(data_path="scale", frame=frame)
    for obj in [rig, mouth, *eyes]:
        if obj.animation_data and obj.animation_data.action:
            obj.animation_data.action.name = "Nexus_" + config["action"]
            for curve in obj.animation_data.action.fcurves:
                for point in curve.keyframe_points:
                    point.interpolation = "LINEAR"
    scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [rig, *character]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=str(job / "character.glb"), export_format="GLB",
                              use_selection=True, export_animations=True, export_skins=True,
                              export_force_sampling=True)

    floor = material("Stage", (.018, .026, .045), metallic=.15)
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(floor)
    for location, power, size in (((-3, -4, 5), 500, 4), ((3, 1, 3), 650, 3)):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.data.energy, light.data.size = power, size
        light.rotation_euler = (Vector((0, 0, 1)) - light.location).to_track_quat("-Z", "Y").to_euler()
    target = Vector((0, 0, 1.02 if config["camera"] == "body" else 1.65))
    bpy.ops.object.camera_add(location=(2.3, -5, 2.1) if config["camera"] == "body" else (.4, -3, 1.8))
    camera = bpy.context.object
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.45 if config["camera"] == "body" else .85
    scene.camera = camera
    report = {**config, "engine": "blender-procedural-rig-v1", "boneCount": len(bones),
              "bones": list(bones), "skinnedMeshes": len(character),
              "frames": scene.frame_end, "renderDevice": "cloud-CPU",
              "samples": scene.cycles.samples, "maxBounces": scene.cycles.max_bounces,
              "outputMode": "still" if still else "video",
              "photoReconstruction": False, "mouthTiming": "audio-energy-not-visemes",
              "identity": "stylized-blue-hoodie-prototype"}
    (job / "rig-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    bpy.ops.wm.save_as_mainfile(filepath=str(job / "character.blend"))
    if still:
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = str(job / "preview.png")
        bpy.ops.render.render(write_still=True)
    else:
        bpy.ops.render.render(animation=True)
    print("SKELETON_RENDERED", json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
