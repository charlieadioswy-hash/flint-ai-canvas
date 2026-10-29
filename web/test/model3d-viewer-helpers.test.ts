import { expect, test } from "bun:test";
import { Box3, BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { createModel3DGround, projectModel3DAxes } from "@/components/assets/model3d-viewer-helpers";
import { disposePrevisObject3D } from "@/lib/canvas/previs/previs-resources";

test("ground sits below the normalized model without changing its center or source transform", () => {
    const model = new Mesh(new BoxGeometry(8, 2, 4), new MeshBasicMaterial());
    model.position.set(7, 11, -5);
    const originalPosition = model.position.clone();
    const group = new Group();
    group.add(model);
    group.scale.setScalar(2.5 / 8);
    group.position.copy(originalPosition).multiplyScalar(-group.scale.x);
    const bounds = new Box3().setFromObject(group);
    const ground = createModel3DGround(bounds, new Color());
    const after = new Box3().setFromObject(group);

    expect(after.equals(bounds)).toBe(true);
    expect(model.position.equals(originalPosition)).toBe(true);
    expect(after.getCenter(new Vector3()).length()).toBeCloseTo(0);
    expect(ground.position.y).toBeLessThan(bounds.min.y);
    expect(bounds.min.y - ground.position.y).toBeLessThan(0.01);
    expect(ground.position.x).toBeCloseTo(0);
    expect(ground.position.z).toBeCloseTo(0);
    const gridBounds = new Box3().setFromObject(ground);
    expect(gridBounds.min.x).toBeLessThan(bounds.min.x);
    expect(gridBounds.max.z).toBeGreaterThan(bounds.max.z);
    disposePrevisObject3D(ground);
    disposePrevisObject3D(model);
});

test("flat and tall models retain a usable reference grid at their own base", () => {
    for (const size of [new Vector3(2.5, 0, 1), new Vector3(0.1, 2.5, 0.1)]) {
        const bounds = new Box3().setFromCenterAndSize(new Vector3(), size);
        const ground = createModel3DGround(bounds, new Color());
        const gridSize = new Box3().setFromObject(ground).getSize(new Vector3());
        expect(gridSize.x).toBeGreaterThanOrEqual(3);
        expect(ground.position.y).toBeCloseTo(bounds.min.y - 0.005);
        expect(ground.material.depthWrite).toBe(false);
        expect(ground.material.depthTest).toBe(true);
        disposePrevisObject3D(ground);
    }
});

test("invalid bounds are rejected before allocating a ground helper", () => {
    for (const bounds of [new Box3(), new Box3(new Vector3(), new Vector3()), new Box3(new Vector3(), new Vector3(Infinity, 1, 1))]) {
        expect(() => createModel3DGround(bounds, new Color())).toThrow("模型没有可预览的几何体");
    }
});

test("ground geometry and material are owned and released by the viewer disposal path", () => {
    const ground = createModel3DGround(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), new Color());
    let geometryDisposals = 0;
    let materialDisposals = 0;
    ground.geometry.addEventListener("dispose", () => geometryDisposals++);
    ground.material.addEventListener("dispose", () => materialDisposals++);
    disposePrevisObject3D(ground);
    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toBe(1);
});

test("front and side views project XYZ using camera direction with SVG Y pointing down", () => {
    const front = projectModel3DAxes(new Quaternion());
    expect(front[0].x).toBeCloseTo(1);
    expect(front[1].y).toBeCloseTo(-1);
    expect(front[2].x).toBeCloseTo(0);
    expect(front[2].y).toBeCloseTo(0);
    expect(front[2].depth).toBeCloseTo(1);

    const camera = new PerspectiveCamera();
    camera.position.set(5, 0, 0);
    camera.lookAt(0, 0, 0);
    const side = projectModel3DAxes(camera.quaternion);
    expect(side[0].x).toBeCloseTo(0);
    expect(side[0].depth).toBeCloseTo(1);
    expect(side[1].y).toBeCloseTo(-1);
    expect(side[2].x).toBeCloseTo(-1);
});

test("orbit and reset update the axes while zoom leaves their orientation unchanged", () => {
    const camera = new PerspectiveCamera();
    camera.position.set(2.7, 1.6, 3.2);
    camera.lookAt(0, 0, 0);
    const originalQuaternion = camera.quaternion.clone();
    const initial = projectModel3DAxes(camera.quaternion);
    expect(camera.quaternion.equals(originalQuaternion)).toBe(true);
    camera.position.multiplyScalar(3);
    camera.lookAt(0, 0, 0);
    const zoomed = projectModel3DAxes(camera.quaternion);
    initial.forEach((axis, index) => {
        expect(zoomed[index].x).toBeCloseTo(axis.x);
        expect(zoomed[index].y).toBeCloseTo(axis.y);
        expect(zoomed[index].depth).toBeCloseTo(axis.depth);
    });
    camera.position.set(-3, 2, -4);
    camera.lookAt(0, 0, 0);
    expect(projectModel3DAxes(camera.quaternion)[0].x).toBeLessThan(0);
    camera.position.set(2.7, 1.6, 3.2);
    camera.lookAt(0, 0, 0);
    expect(projectModel3DAxes(camera.quaternion)).toEqual(initial);
});
