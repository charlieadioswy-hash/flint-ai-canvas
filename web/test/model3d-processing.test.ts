import { expect, test } from "bun:test";
import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3, VectorKeyframeTrack } from "three";
import { createModel3DPlayback, model3DPartObjects } from "@/components/assets/model3d-playback";
import { model3DAnimationOptions, model3DProcessingOptions } from "@/pages/model3d/model3d-processing-state";
import type { Model3DTaskView } from "@/services/api/model3d";
import { createModel3DPartsLayout, frameModel3DParts } from "@/components/assets/model3d-parts-layout";

test("separated model fits below controls and above the footer across preview widths", () => {
    const bounds = new Box3(new Vector3(-2, -1, -0.5), new Vector3(2, 1, 0.5));
    for (const [width, height, toolsHeight] of [
        [360, 340, 85],
        [660, 340, 85],
        [360, 340, 230],
        [1280, 720, 85],
    ])
        for (const position of [new Vector3(0, 0, 5), new Vector3(2.7, 1.6, 3.2), new Vector3(5, 0, 0)]) {
            const camera = new PerspectiveCamera(40, width / height, 0.01, 100);
            camera.position.copy(position);
            camera.lookAt(bounds.getCenter(new Vector3()));
            const direction = camera.getWorldDirection(new Vector3());
            frameModel3DParts(camera, [bounds], width, height, toolsHeight);
            expect(camera.getWorldDirection(new Vector3()).distanceTo(direction)).toBeLessThan(1e-12);
            for (const x of [bounds.min.x, bounds.max.x])
                for (const y of [bounds.min.y, bounds.max.y])
                    for (const z of [bounds.min.z, bounds.max.z]) {
                        const projected = new Vector3(x, y, z).project(camera);
                        const screenY = ((1 - projected.y) * height) / 2;
                        expect(Math.abs(projected.x)).toBeLessThan(1);
                        expect(screenY).toBeGreaterThan(toolsHeight + 8);
                        expect(screenY).toBeLessThan(height - 32);
                    }
        }
});

test("exploded assembly framing uses occupied parts without shrinking to empty outer corners", () => {
    const boxes = [new Box3(new Vector3(-0.3, -1.5, -0.3), new Vector3(0.3, 1.5, 0.3)), new Box3(new Vector3(-1.5, 0, -0.3), new Vector3(1.5, 0.3, 0.3))];
    const camera = new PerspectiveCamera(40, 660 / 370, 0.01, 100);
    camera.position.set(2.7, 1.6, 3.2);
    camera.lookAt(0, 0, 0);
    frameModel3DParts(camera, boxes, 660, 370, 85);
    const screenYs: number[] = [];
    for (const box of boxes) {
        for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) {
                    const projected = new Vector3(x, y, z).project(camera);
                    expect(Math.abs(projected.x)).toBeLessThan(1);
                    screenYs.push((1 - projected.y) * 185);
                }
    }
    expect(Math.min(...screenYs)).toBeGreaterThan(101);
    expect(Math.max(...screenYs)).toBeLessThan(338);
    expect(Math.max(...screenYs) - Math.min(...screenYs)).toBeGreaterThan(190);
});

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
    const part = new Group();
    part.name = "moving";
    root.add(part);
    root.animations = [new AnimationClip("walk", 2, [new VectorKeyframeTrack("moving.position", [0, 2], [0, 0, 0, 2, 0, 0])])];
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    let draws = 0;
    const player = createModel3DPlayback(
        root,
        () => draws++,
        () => {},
        (callback) => {
            frames.set(++id, callback);
            return id;
        },
        (value) => {
            frames.delete(value);
        },
    );
    const tick = (time: number) => {
        const next = frames.entries().next().value;
        if (next) {
            frames.delete(next[0]);
            next[1](time);
        }
    };
    expect(frames.size).toBe(0);
    player.play();
    tick(1000);
    tick(1100);
    expect(part.position.x).toBeCloseTo(0.1);
    player.pause();
    const pausedDraws = draws;
    expect(frames.size).toBe(0);
    tick(1200);
    expect(draws).toBe(pausedDraws);
    player.seek(1);
    expect(part.position.x).toBeCloseTo(1);
    player.play();
    player.setVisible(false);
    expect(frames.size).toBe(0);
    player.setVisible(true);
    tick(9000);
    expect(part.position.x).toBeCloseTo(1);
    player.dispose();
    expect(frames.size).toBe(0);
    player.play();
    expect(frames.size).toBe(0);
});

test("part controls preserve hierarchy and do not rename source nodes", () => {
    const model = new Group();
    const part = new Group();
    part.name = "tripo_part_0";
    const child = new Group();
    child.name = part.name;
    part.add(child);
    model.add(part);
    const parts = model3DPartObjects(model, ["tripo_part_0"]);
    expect(parts.map((item) => item.name)).toEqual(["tripo_part_0"]);
    parts[0].object.visible = false;
    expect(part.visible).toBe(false);
    expect(child.parent).toBe(part);
    expect(part.name).toBe("tripo_part_0");
});

test("exploded parts keep the assembly structure, orientation and size beneath transformed parents", () => {
    const model = new Group();
    model.position.set(5, -3, 2);
    model.scale.set(2, 0.5, 1.5);
    model.rotation.set(0.2, 0.5, -0.1);
    const geometry = new BoxGeometry(0.5, 0.5, 0.5);
    const material = new MeshBasicMaterial();
    const centers = [
        [0, 0, 0],
        [0, 1.4, 0],
        [-1.4, 0.5, 0],
        [1.4, 0.5, 0],
        [-0.4, -1.4, 0.25],
        [0.4, -1.4, 0.25],
    ];
    const parts = centers.map(([x, y, z], index) => {
        const parent = new Group();
        parent.rotation.z = index * 0.1;
        model.add(parent);
        const object = new Mesh(geometry, material);
        object.name = `part_${index}`;
        object.position.set(x, y, z);
        parent.add(object);
        return { object };
    });
    model.updateMatrixWorld(true);
    const original = parts.map(({ object }) => ({ parent: object.parent, position: object.position.clone(), rotation: object.quaternion.clone(), scale: object.scale.clone(), matrix: object.matrixWorld.clone(), bounds: new Box3().setFromObject(object) }));
    const arrange = createModel3DPartsLayout(parts);
    try {
        for (let cycle = 0; cycle < 3; cycle++) {
            arrange(true);
            const bounds = parts.map(({ object }) => new Box3().setFromObject(object));
            bounds.forEach((box, i) => {
                expect(box.getSize(new Vector3()).distanceTo(original[i].bounds.getSize(new Vector3()))).toBeLessThan(1e-12);
                bounds.slice(i + 1).forEach((other, j) => {
                    const before = original[i + j + 1].bounds.getCenter(new Vector3()).sub(original[i].bounds.getCenter(new Vector3()));
                    const after = other.getCenter(new Vector3()).sub(box.getCenter(new Vector3()));
                    expect(after.length()).toBeGreaterThan(before.length());
                    expect(after.normalize().distanceTo(before.normalize())).toBeLessThan(1e-12);
                });
                expect(parts[i].object.quaternion.equals(original[i].rotation)).toBe(true);
                expect(parts[i].object.scale.equals(original[i].scale)).toBe(true);
            });
            parts[0].object.visible = false;
            arrange(false);
            expect(parts[0].object.visible).toBe(false);
            parts.forEach(({ object }, index) => {
                expect(object.parent).toBe(original[index].parent);
                expect(object.position.equals(original[index].position)).toBe(true);
                expect(object.matrixWorld.equals(original[index].matrix)).toBe(true);
                expect(object.geometry).toBe(geometry);
            });
        }
    } finally {
        geometry.dispose();
        material.dispose();
    }
});

test("explosion creates gaps at touching parts using geometry centers even when origins coincide", () => {
    const root = new Group();
    const material = new MeshBasicMaterial();
    const parts = [
        [0, 0, 0],
        [-1, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
    ].map(([x, y, z]) => {
        const object = new Mesh(new BoxGeometry(1, 1, 1).translate(x, y, z), material);
        root.add(object);
        return { object };
    });
    const originalBounds = parts.map(({ object }) => new Box3().setFromObject(object));
    const arrange = createModel3DPartsLayout(parts);
    try {
        arrange(true);
        expect(parts[0].object.position.length()).toBe(0);
        const bounds = parts.map(({ object }) => new Box3().setFromObject(object));
        bounds.forEach((box, i) => bounds.slice(i + 1).forEach((other) => expect(box.intersectsBox(other)).toBe(false)));
        parts.forEach(({ object }) => expect(object.scale.toArray()).toEqual([1, 1, 1]));
        arrange(false);
        parts.forEach(({ object }, i) => {
            expect(object.position.length()).toBe(0);
            expect(new Box3().setFromObject(object).equals(originalBounds[i])).toBe(true);
        });
    } finally {
        parts.forEach(({ object }) => object.geometry.dispose());
        material.dispose();
    }
});
