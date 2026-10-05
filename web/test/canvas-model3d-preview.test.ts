import { expect, test } from "bun:test";
import { Box3, Mesh, Vector3 } from "three";
import { createModel3DFBXLoader, createModel3DGLTFLoader } from "@/lib/canvas/model3d-preview";
import { disposeDirectorObject3D } from "@/lib/canvas/director/director-resources";

// Deterministic triangle buffer encoded by meshopt; no network or external texture dependencies.
const compressedVertices = [160,0,0,1,12,0,0,0,255,1,60,0,0,0,255,125,0,0,1,12,0,0,0,255,1,12,0,0,0,126,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,128,191,0,0,0,0,0,0,0,0];
function glb(compressed: boolean) {
    const binary = compressed ? Uint8Array.from(compressedVertices) : new Uint8Array(new Float32Array([-1,0,0, 1,0,0, 0,1,0]).buffer);
    const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }], buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, ...(compressed ? { extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: binary.length, byteStride: 12, count: 3, mode: "ATTRIBUTES", filter: "NONE" } } } : {}) }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1,0,0], max: [1,1,0] }], ...(compressed ? { extensionsUsed: ["EXT_meshopt_compression"], extensionsRequired: ["EXT_meshopt_compression"] } : {}) };
    const encoded = new TextEncoder().encode(JSON.stringify(json));
    const jsonSize = Math.ceil(encoded.length / 4) * 4;
    const binarySize = Math.ceil(binary.length / 4) * 4;
    const result = new ArrayBuffer(12 + 8 + jsonSize + 8 + binarySize);
    const view = new DataView(result); const bytes = new Uint8Array(result);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.byteLength, true);
    view.setUint32(12, jsonSize, true); view.setUint32(16, 0x4e4f534a, true); bytes.fill(32, 20, 20 + jsonSize); bytes.set(encoded, 20);
    view.setUint32(20 + jsonSize, binarySize, true); view.setUint32(24 + jsonSize, 0x004e4942, true); bytes.set(binary, 28 + jsonSize);
    return result;
}

test("real GLB loader parses ordinary and meshopt compressed model geometry offline", async () => {
    for (const compressed of [false, true]) {
        const model = (await createModel3DGLTFLoader().parseAsync(glb(compressed), "")).scene;
        const bounds = new Box3().setFromObject(model).getSize(new Vector3());
        expect(bounds.x).toBeCloseTo(2); expect(bounds.y).toBeCloseTo(1);
        let vertices = 0; model.traverse((object) => { if (object instanceof Mesh) vertices += object.geometry.getAttribute("position").count; });
        expect(vertices).toBe(3); disposeDirectorObject3D(model);
    }
});

const fbxTriangle = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
Objects:  {
\tGeometry: 1, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: -1,0,0,1,0,0,0,1,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2, "Model::Triangle", "Mesh" {
\t\tVersion: 232
\t}
}
Connections:  {
\tC: "OO",1,2
\tC: "OO",2,0
}
`;

test("real FBX loader parses quad-output format and owned geometry/material dispose once", () => {
    const model = createModel3DFBXLoader().parse(new TextEncoder().encode(fbxTriangle).buffer, "");
    const bounds = new Box3().setFromObject(model).getSize(new Vector3());
    expect(bounds.x).toBeCloseTo(2); expect(bounds.y).toBeCloseTo(1);
    let meshes = 0; let geometryDisposals = 0; let materialDisposals = 0;
    model.traverse((object) => { if (object instanceof Mesh) { meshes++; object.geometry.addEventListener("dispose", () => geometryDisposals++); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach((material) => material.addEventListener("dispose", () => materialDisposals++)); } });
    expect(meshes).toBe(1); disposeDirectorObject3D(model);
    expect(geometryDisposals).toBe(1); expect(materialDisposals).toBe(1);
});
