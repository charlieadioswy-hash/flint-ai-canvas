import json
import math
import os
from pathlib import Path
import socket
import struct
import sys

import bpy


class ConversionFailure(Exception):
    pass


def deny_network(*args, **kwargs):
    raise ConversionFailure("external")


def source_clips(source, source_format):
    if source_format in {"glb", "gltf"}:
        data = source.read_bytes()
        if source_format == "glb":
            length = struct.unpack_from("<I", data, 12)[0]
            data = data[20:20 + length].rstrip(b"\0 ")
        document = json.loads(data)
        from io_scene_gltf2.blender.imp.blender_gltf import BlenderGlTF
        clips, tracks, used_names = [], [], set()
        for index, animation in enumerate(document.get("animations", [])):
            clips.append(animation.get("name") or "animation_%d" % index)
            # Headless import does not register the animation picker UI. Use
            # the importer's naming rule to find its stashed NLA tracks.
            name = BlenderGlTF.find_unused_name(used_names, animation.get("name") or "Anim_%d" % index)
            tracks.append(name)
            used_names.add(name)
        return clips, tracks
    if source_format == "fbx":
        if not source.read_bytes().startswith(b"Kaydara FBX Binary"):
            raise ConversionFailure("invalid_source")
        from io_scene_fbx import parse_fbx
        root, _ = parse_fbx.parse(str(source))
        objects = next((item for item in root.elems if item.id == b"Objects"), None)
        if objects is None:
            raise ConversionFailure("invalid_source")
        stacks = [item for item in objects.elems if item.id == b"AnimationStack"]
        return [item.props[1].split(b"\x00\x01")[0].decode("utf-8", "replace")
                for item in stacks], [item.props[0] for item in stacks]
    return [], []


def import_source(source, source_format):
    stack_actions = {}
    if source_format in {"glb", "gltf"}:
        result = bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True, disable_bone_shape=True)
    elif source_format == "fbx":
        from bpy_extras import image_utils
        from io_scene_fbx import import_fbx
        original = image_utils.load_image
        original_animations = import_fbx.blen_read_animations

        def capture_animations(*args, **kwargs):
            stacks = kwargs["stacks"] if "stacks" in kwargs else args[2]
            destinations = {}
            for stack_id, (_, layers) in stacks.items():
                for _, items in layers.values():
                    for item, curves in items.items():
                        if isinstance(item, bpy.types.ShapeKey):
                            owner = item.id_data
                        else:
                            owner = getattr(item, "bl_obj", item)
                        destinations[id(curves)] = (stack_id, owner)
            original_action_item = import_fbx.blen_read_animations_action_item

            def capture_action_item(action, item, curves, *rest, **named):
                stack_id, owner = destinations[id(curves)]
                actions = stack_actions.setdefault(stack_id, {}).setdefault(owner, set())
                actions.add(action)
                return original_action_item(action, item, curves, *rest, **named)

            # The importer truncates and uniquifies action names. Capture its
            # actual stack/object association before that identity is lost.
            import_fbx.blen_read_animations_action_item = capture_action_item
            try:
                return original_animations(*args, **kwargs)
            finally:
                import_fbx.blen_read_animations_action_item = original_action_item

        # FBX's importer tries referenced filenames before packing embedded
        # bytes. Give it placeholders so model-controlled paths are never read.
        def embedded_placeholder(filepath, **kwargs):
            return bpy.data.images.new("embedded", width=1, height=1)

        image_utils.load_image = embedded_placeholder
        import_fbx.blen_read_animations = capture_animations
        try:
            result = bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
        finally:
            image_utils.load_image = original
            import_fbx.blen_read_animations = original_animations
        if any(not image.packed_file for image in bpy.data.images):
            raise ConversionFailure("external")
    elif source_format == "obj":
        result = bpy.ops.wm.obj_import(filepath=str(source))
    else:
        result = bpy.ops.wm.stl_import(filepath=str(source))
    if "FINISHED" not in result:
        raise ConversionFailure("invalid_source")
    return stack_actions


def animated_ids():
    result = list(bpy.data.objects)
    result.extend(bpy.data.shape_keys)
    return [item for item in result if item.animation_data]


def action_curves(action):
    curves = []
    if action.is_action_legacy:
        curves.extend(action.fcurves)
    else:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    curves.extend(bag.fcurves)
    return curves


def rescale_actions(factor):
    if abs(factor - 1.0) < 0.000001:
        return
    for action in bpy.data.actions:
        for curve in action_curves(action):
            for point in curve.keyframe_points:
                point.co.x *= factor
                point.handle_left.x *= factor
                point.handle_right.x *= factor
    for item in animated_ids():
        for track in item.animation_data.nla_tracks:
            for strip in track.strips:
                strip.frame_start *= factor
                strip.frame_end *= factor


def activate_clip(clip, clips, track_names, source_format, stack_actions):
    actions = []
    if source_format in {"glb", "gltf"}:
        if len(track_names) != len(clips) or clips.count(clip) != 1:
            raise ConversionFailure("invalid_animation")
        track_name = track_names[clips.index(clip)]
        for item in animated_ids():
            animation = item.animation_data
            animation.action = None
            animation.use_nla = False
            for track in animation.nla_tracks:
                track.mute = True
                if track.name == track_name and len(track.strips) == 1:
                    strip = track.strips[0]
                    animation.action = strip.action
                    if hasattr(strip, "action_slot"):
                        animation.action_slot = strip.action_slot
                    actions.append(strip.action)
    else:
        imported = stack_actions.get(track_names[clips.index(clip)], {})
        for item in animated_ids():
            animation = item.animation_data
            matching = list(imported.get(item, ()))
            if len(matching) > 1:
                raise ConversionFailure("invalid_animation")
            animation.action = matching[0] if matching else None
            animation.use_nla = False
            if matching:
                if hasattr(matching[0], "slots") and matching[0].slots:
                    animation.action_slot = matching[0].slots[0]
                actions.append(matching[0])
    if not actions:
        raise ConversionFailure("invalid_animation")
    start = min(action.frame_range[0] for action in actions)
    end = max(action.frame_range[1] for action in actions)
    if not math.isfinite(start) or not math.isfinite(end) or end < start:
        raise ConversionFailure("invalid_animation")
    bpy.context.scene.frame_start = math.floor(start)
    bpy.context.scene.frame_end = math.ceil(end)
    bpy.context.scene.frame_set(bpy.context.scene.frame_start)


def convert(request):
    source = Path(request["sourcePath"])
    source_format = request["sourceFormat"]
    options = request["options"]
    output = request["outputPath"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    socket.create_connection = deny_network
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    clips, track_names = source_clips(source, source_format)
    clip = options.get("animation", "")
    if clip and clips.count(clip) != 1:
        raise ConversionFailure("missing_clip")
    if options["format"] == "abc" and len(clips) > 1 and not clip:
        raise ConversionFailure("multiple_clips")
    scene = bpy.context.scene
    fps = options["fps"]
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    stack_actions = import_source(source, source_format)
    original_fps = scene.render.fps / scene.render.fps_base
    if source_format == "fbx":
        rescale_actions(fps / original_fps)
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    if not any(obj.type == "MESH" and len(obj.data.vertices) >= 3 and len(obj.data.polygons)
               for obj in scene.objects):
        raise ConversionFailure("no_geometry")
    # FBX's all-actions exporter bakes each object independently. A glTF clip
    # spanning several animated IDs would become separate, incomplete takes.
    if options["format"] == "fbx" and len(clips) > 1 and not clip and len(animated_ids()) > 1:
        raise ConversionFailure("complex_animation")
    if clip or len(clips) == 1:
        activate_clip(clip or clips[0], clips, track_names, source_format, stack_actions)
    elif not clips:
        scene.frame_start = scene.frame_end = 1
        scene.frame_set(1)
    if options["format"] == "fbx":
        for image in bpy.data.images:
            if not image.packed_file:
                image.pack()
        result = bpy.ops.export_scene.fbx(
            filepath=output, check_existing=False, object_types={"MESH", "ARMATURE", "EMPTY"},
            path_mode="COPY", embed_textures=True, add_leaf_bones=False,
            use_mesh_modifiers=False, bake_anim=bool(clips),
            bake_anim_use_nla_strips=False,
            bake_anim_use_all_actions=len(clips) > 1 and not clip,
            bake_anim_simplify_factor=0.0)
    else:
        if not bpy.app.build_options.alembic:
            raise ConversionFailure("unsupported")
        result = bpy.ops.wm.alembic_export(
            filepath=output, check_existing=False,
            start=scene.frame_start, end=scene.frame_end,
            uvs=True, normals=True, face_sets=True, flatten=False,
            export_hair=False, export_particles=False, as_background_job=False,
            init_scene_frame_range=False)
    if "FINISHED" not in result:
        raise ConversionFailure("unsupported")


if __name__ == "__main__":
    request = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
    try:
        convert(request)
    except ConversionFailure as error:
        Path(request["statusPath"]).write_text(json.dumps({"code": str(error)}))
        raise
    except Exception:
        Path(request["statusPath"]).write_text(json.dumps({"code": "failed"}))
        raise
    else:
        Path(request["statusPath"]).write_text(json.dumps({"code": "ok"}))
