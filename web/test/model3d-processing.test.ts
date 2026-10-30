import { expect, test } from "bun:test";
import { AnimationClip, Group, VectorKeyframeTrack } from "three";
import { createModel3DPlayback, model3DPartObjects } from "@/components/assets/model3d-playback";
import { model3DAnimationOptions, model3DProcessingOptions } from "@/pages/model3d/model3d-processing-state";
import type { Model3DTaskView } from "@/services/api/model3d";

test("processing prerequisites follow completed source kind and matching rig presets", () => {
    const task = { status: "succeeded", scope: "standalone", result: { resourceId: "result" } } as Model3DTaskView;
    expect(model3DProcessingOptions(task)).toEqual(["segment", "rig_check"]);
    expect(model3DProcessingOptions({ ...task, status: "running" })).toEqual([]);
    expect(model3DProcessingOptions({ ...task, processing: { operation: "segment", sourceTaskId: "source" } })).toEqual(["complete"]);
    expect(model3DProcessingOptions({ ...task, processing: { operation: "complete", sourceTaskId: "source" } })).toEqual([]);
    expect(model3DProcessingOptions({ ...task, processing: { operation: "rig", sourceTaskId: "source", rigType: "avian" } })).toEqual([]);
    expect(model3DAnimationOptions("quadruped").map((item) => item.value)).toEqual(["preset:quadruped:walk"]);
    expect(model3DAnimationOptions("biped").map((item) => item.value)).toContain("preset:walk");
    expect(model3DAnimationOptions("biped").map((item) => item.value)).not.toContain("preset:biped:walk");
});

test("animation updates geometry only while playing, pauses offscreen and releases frames", () => {
    const root = new Group();
    const part = new Group(); part.name = "moving"; root.add(part);
    root.animations = [new AnimationClip("walk", 2, [new VectorKeyframeTrack("moving.position", [0, 2], [0, 0, 0, 2, 0, 0])])];
    const frames = new Map<number, FrameRequestCallback>(); let id = 0; let draws = 0;
    const player = createModel3DPlayback(root, () => draws++, () => {}, (callback) => { frames.set(++id, callback); return id; }, (value) => { frames.delete(value); });
    const tick = (time: number) => { const next = frames.entries().next().value; if (next) { frames.delete(next[0]); next[1](time); } };
    expect(frames.size).toBe(0);
    player.play(); tick(1000); tick(1100);
    expect(part.position.x).toBeCloseTo(0.1);
    player.pause(); const pausedDraws = draws;
    expect(frames.size).toBe(0); tick(1200); expect(draws).toBe(pausedDraws);
    player.seek(1); expect(part.position.x).toBeCloseTo(1);
    player.play(); player.setVisible(false); expect(frames.size).toBe(0);
    player.setVisible(true); tick(9000); expect(part.position.x).toBeCloseTo(1);
    player.dispose(); expect(frames.size).toBe(0);
    player.play(); expect(frames.size).toBe(0);
});

test("part controls preserve hierarchy and do not rename source nodes", () => {
    const model = new Group(); const part = new Group(); part.name = "tripo_part_0"; const child = new Group(); part.add(child); model.add(part);
    const parts = model3DPartObjects(model, ["tripo_part_0"]);
    expect(parts.map((item) => item.name)).toEqual(["tripo_part_0"]);
    parts[0].object.visible = false;
    expect(part.visible).toBe(false);
    expect(child.parent).toBe(part);
    expect(part.name).toBe("tripo_part_0");
});
