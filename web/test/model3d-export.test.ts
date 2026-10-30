import { afterAll, beforeAll, expect, test } from "bun:test";
import { AnimationClip, AnimationMixer, Bone, Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, VectorKeyframeTrack } from "three";

import { MODEL3D_MAX_BYTES, parseModel3D, readModel3DSource } from "@/lib/canvas/model3d-preview";
import { disposePrevisObject3D } from "@/lib/canvas/previs/previs-resources";
import { exportModel3D, exportModel3DObject } from "@/lib/model3d-export";
import { model3DFileName, model3DFormat } from "@/lib/model3d-formats";

const originalReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
const originalProgress = Object.getOwnPropertyDescriptor(globalThis, "ProgressEvent");

beforeAll(() => {
    // Browser FileReader is the only browser API needed for geometry exports.
    if (!originalReader)
        Object.defineProperty(globalThis, "FileReader", {
            configurable: true,
            value: class {
                result: ArrayBuffer | string | null = null;
                onloadend?: () => void;
                readAsArrayBuffer(blob: Blob) {
                    void blob.arrayBuffer().then((bytes) => {
                        this.result = bytes;
                        this.onloadend?.();
                    });
                }
                readAsDataURL(blob: Blob) {
                    void blob.arrayBuffer().then((bytes) => {
                        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                        this.onloadend?.();
                    });
                }
            },
        });
    if (!originalProgress)
        Object.defineProperty(globalThis, "ProgressEvent", {
            configurable: true,
            value: class extends Event {
                constructor(type: string, init: ProgressEventInit) {
                    super(type);
                    Object.assign(this, init);
                }
            },
        });
});

afterAll(() => {
    if (originalReader) Object.defineProperty(globalThis, "FileReader", originalReader);
    else Reflect.deleteProperty(globalThis, "FileReader");
    if (originalProgress) Object.defineProperty(globalThis, "ProgressEvent", originalProgress);
    else Reflect.deleteProperty(globalThis, "ProgressEvent");
});

const obj = "v -1 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
function triangle() {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.computeVertexNormals();
    const material = new MeshStandardMaterial({ color: 0x85b9cf, metalness: 0.7, roughness: 0.2 });
    const mesh = new Mesh(geometry, material);
    mesh.position.set(4, 2, -3);
    mesh.scale.setScalar(2);
    const model = new Group();
    model.add(mesh);
    return model;
}

test("formats recognise five preview formats and sanitise names with a single extension", () => {
    for (const format of ["glb", "gltf", "fbx", "obj", "stl"]) expect(model3DFormat({ fileName: `model.${format.toUpperCase()}` })).toBe(format);
    expect(model3DFormat({ mimeType: "model/stl" })).toBe("stl");
    expect(model3DFormat({ url: "https://example.invalid/model.obj?signature=secret" })).toBe("obj");
    expect(model3DFormat({ fileName: "model.zip" })).toBeNull();
    expect(model3DFileName("a/b:mesh.GLB", "obj")).toBe("a_b_mesh.obj");
});

test("OBJ and binary STL round trip through real loaders without preview scaling or centring", async () => {
    const model = triangle();
    try {
        for (const format of ["obj", "stl"] as const) {
            const result = await exportModel3DObject(model, format, "triangle.glb");
            expect(result.fileName).toBe(`triangle.${format}`);
            expect(result.mimeType).toBe(`model/${format}`);
            const loaded = await parseModel3D(await result.blob.arrayBuffer(), format);
            const bounds = new Box3().setFromObject(loaded);
            expect(bounds.min.toArray()).toEqual([2, 2, -3]);
            expect(bounds.max.toArray()).toEqual([6, 4, -3]);
            disposePrevisObject3D(loaded);
        }
        expect(model.children[0].position.toArray()).toEqual([4, 2, -3]);
    } finally {
        disposePrevisObject3D(model);
    }
});

test("GLB and self-contained GLTF preserve geometry and standard material parameters", async () => {
    const model = triangle();
    try {
        for (const format of ["glb", "gltf"] as const) {
            const result = await exportModel3DObject(model, format);
            if (format === "gltf") {
                const json = JSON.parse(await result.blob.text());
                expect(json.buffers[0].uri).toStartWith("data:application/octet-stream;base64,");
            }
            const loaded = await parseModel3D(await result.blob.arrayBuffer(), format);
            let material: MeshStandardMaterial | undefined;
            loaded.traverse((object) => {
                if (object instanceof Mesh) material = object.material as MeshStandardMaterial;
            });
            expect(new Box3().setFromObject(loaded).getSize(new Vector3()).toArray()).toEqual([4, 2, 0]);
            expect(material?.color.getHex()).toBe(0x85b9cf);
            expect(material?.roughness).toBeCloseTo(0.2);
            expect(material?.metalness).toBeCloseTo(0.7);
            disposePrevisObject3D(loaded);
        }
    } finally {
        disposePrevisObject3D(model);
    }
});

test("GLB and GLTF round trips retain a working skin and bone animation", async () => {
    const model = new Group();
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    geometry.computeVertexNormals();
    const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
    mesh.name = "body";
    const root = new Bone();
    root.name = "root";
    const tip = new Bone();
    tip.name = "tip";
    tip.position.y = 1;
    root.add(tip);
    mesh.add(root);
    model.add(mesh);
    model.updateMatrixWorld(true);
    mesh.bind(new Skeleton([root, tip]));
    model.animations = [new AnimationClip("wave", 1, [new VectorKeyframeTrack("tip.position", [0, 1], [0, 1, 0, 1, 1, 0])])];
    try {
        for (const format of ["glb", "gltf"] as const) {
            const exported = await exportModel3DObject(model, format);
            const loaded = await parseModel3D(await exported.blob.arrayBuffer(), format);
            const mixer = new AnimationMixer(loaded);
            try {
                const restoredMesh = loaded.getObjectByName("body") as SkinnedMesh;
                expect(restoredMesh.isSkinnedMesh).toBe(true);
                expect(restoredMesh.skeleton.bones.map((bone) => bone.name)).toEqual(["root", "tip"]);
                expect(loaded.animations.map((clip) => clip.name)).toEqual(["wave"]);
                mixer.clipAction(loaded.animations[0]).play();
                mixer.update(0.5);
                loaded.updateMatrixWorld(true);
                const vertex = restoredMesh.getVertexPosition(2, new Vector3());
                expect(vertex.x).toBeCloseTo(0.5);
                expect(vertex.y).toBeCloseTo(1);
                expect(vertex.z).toBeCloseTo(0);
            } finally {
                mixer.stopAllAction();
                mixer.uncacheRoot(loaded);
                disposePrevisObject3D(loaded);
            }
        }
        expect(tip.position.toArray()).toEqual([0, 1, 0]);
    } finally {
        disposePrevisObject3D(model);
    }
});

test("source conversion can read a local model and returns a downloadable result", async () => {
    const source = { url: `data:model/obj;base64,${Buffer.from(obj).toString("base64")}`, format: "obj" as const, fileName: "local.obj" };
    const result = await exportModel3D(source, "stl");
    expect(result.fileName).toBe("local.stl");
    expect(result.blob.size).toBe(134);
    const loaded = await parseModel3D(await result.blob.arrayBuffer(), "stl");
    expect(new Box3().setFromObject(loaded).getSize(new Vector3()).toArray()).toEqual([2, 1, 0]);
    disposePrevisObject3D(loaded);
});

test("source reads reject HTTP failures and aborted conversions", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    try {
        await expect(readModel3DSource({ url: "https://example.invalid/model.obj", format: "obj" })).rejects.toThrow("读取失败");
    } finally {
        globalThis.fetch = previous;
    }
    const controller = new AbortController();
    controller.abort();
    await expect(exportModel3D({ url: "", format: "obj" }, "stl", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("model reads cancel oversized responses before buffering them", async () => {
    const previous = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () =>
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            }),
            { headers: { "content-length": String(MODEL3D_MAX_BYTES + 1) } },
        )) as typeof fetch;
    try {
        await expect(readModel3DSource({ url: "https://example.invalid/model.obj", format: "obj" })).rejects.toThrow("128 MB");
        expect(cancelled).toBe(true);
    } finally {
        globalThis.fetch = previous;
    }
});
