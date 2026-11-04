import { Box3, Matrix4, Vector3, type Object3D, type PerspectiveCamera } from "three";

/** Reserve the toolbar area while keeping orbit rotation centered on the parts. */
export function frameModel3DParts(camera: PerspectiveCamera, boxes: Box3[], width: number, height: number, toolbarHeight: number) {
    const top = Math.min(Math.max(0, height - 64), Math.max(88, toolbarHeight) + 16);
    const bottom = Math.min(32, height / 4);
    const bounds = new Box3();
    boxes.forEach((box) => bounds.union(box));
    const center = bounds.getCenter(new Vector3());
    const viewRotation = new Matrix4().makeRotationFromQuaternion(camera.quaternion.clone().invert());
    const slope = Math.tan((camera.fov * Math.PI) / 360);
    const horizontalSlope = (slope * width) / height;
    const verticalSlope = (slope * (height - top - bottom)) / height;
    let distance = camera.near;
    // Fit occupied mesh bounds, not empty corners of the assembly's enclosing box.
    for (const box of boxes) {
        for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) {
                    const point = new Vector3(x, y, z).sub(center).applyMatrix4(viewRotation);
                    distance = Math.max(distance, point.z + Math.max(Math.abs(point.x) / horizontalSlope, Math.abs(point.y) / verticalSlope));
                }
    }
    distance *= 1.1;
    camera.far = Math.max(100, distance * 10);
    camera.position.copy(center).add(new Vector3(0, 0, distance).applyQuaternion(camera.quaternion));
    camera.setViewOffset(width, height, 0, -(top - bottom) / 2, width, height);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    return { center, distance };
}

/** Spread part centers uniformly around the assembly center, preserving all relative directions. */
export function createModel3DPartsLayout(parts: Array<{ object: Object3D }>) {
    const entries = parts
        .map(({ object }) => {
            object.updateWorldMatrix(true, true);
            const bounds = new Box3().setFromObject(object);
            return { object, position: object.position.clone(), bounds, inverseParent: object.parent?.matrixWorld.clone().invert() || new Matrix4() };
        })
        .filter(({ bounds }) => !bounds.isEmpty() && [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
    const assemblyBounds = new Box3();
    entries.forEach(({ bounds }) => assemblyBounds.union(bounds));
    const assemblyCenter = assemblyBounds.getCenter(new Vector3());
    const offsets = entries.map(({ bounds, inverseParent }) => {
        const center = bounds.getCenter(new Vector3());
        const target = center.clone().sub(assemblyCenter).multiplyScalar(0.35).add(center);
        return target.applyMatrix4(inverseParent).sub(center.applyMatrix4(inverseParent));
    });
    return (separated: boolean) => {
        entries.forEach(({ object, position }, index) => {
            object.position.copy(position);
            if (separated) object.position.add(offsets[index]);
            object.updateWorldMatrix(false, true);
        });
    };
}
