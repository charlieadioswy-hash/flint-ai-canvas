import { Box3, Color, GridHelper, Quaternion, Vector3 } from "three";

export const MODEL3D_AXES = ["X", "Y", "Z"] as const;
export type Model3DAxis = (typeof MODEL3D_AXES)[number];

/** The model is already centered and normalized; the grid never changes its transform. */
export function createModel3DGround(bounds: Box3, color: Color) {
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const footprint = Math.max(size.x, size.z);
    const extent = Math.max(size.x, size.y, size.z);
    if (bounds.isEmpty() || !Number.isFinite(extent) || extent <= 0 || ![center.x, center.y, center.z].every(Number.isFinite)) {
        throw new Error("模型没有可预览的几何体");
    }
    const grid = new GridHelper(Math.max(3, Math.ceil(footprint * 1.6 * 2) / 2), 20, color, color);
    grid.name = "model3d-ground-reference";
    // A tiny separation avoids coplanar flicker on models with a flat base.
    grid.position.set(center.x, bounds.min.y - extent * 0.002, center.z);
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    grid.material.depthWrite = false;
    grid.material.toneMapped = false;
    return grid;
}

/** Orthographic directions in SVG coordinates, independent of camera zoom and translation. */
export function projectModel3DAxes(cameraQuaternion: Quaternion) {
    const inverse = cameraQuaternion.clone().invert();
    return MODEL3D_AXES.map((axis, index) => {
        const direction = new Vector3(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0).applyQuaternion(inverse);
        return { axis, x: direction.x, y: -direction.y, depth: direction.z };
    });
}
