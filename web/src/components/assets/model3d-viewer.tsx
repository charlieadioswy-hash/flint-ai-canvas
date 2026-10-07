import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { Object3D } from "three";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { getActiveUserScope } from "@/lib/user-scope";
import { disposePrevisObject3D } from "@/lib/canvas/previs/previs-resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { createModel3DFBXLoader, createModel3DGLTFLoader } from "@/lib/canvas/model3d-preview";

type Props = { storageKey?: string; url: string; format: "glb" | "gltf" | "fbx"; theme?: CanvasTheme; expanded?: boolean };

/** Mounted only after entering preview; controls render on demand and own their GPU resources. */
export function Model3DViewer({ storageKey, url, format, theme, expanded = false }: Props) {
    const hostRef = useRef<HTMLDivElement>(null);
    const controller = useRef<{ reset: () => void; rotate: (x: number, y: number) => void } | null>(null);
    const identity = `${getActiveUserScope()}:${storageKey || url}:${format}`;
    const panel = theme?.node.panel || "var(--background)";
    const text = theme?.node.text || "var(--foreground)";
    const muted = theme?.node.muted || "var(--muted-foreground)";
    const stroke = theme?.node.stroke || "var(--border)";
    const [retry, setRetry] = useState(0);
    const [loadedIdentity, setLoadedIdentity] = useState("");
    const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let active = true;
        let cleanup: (() => void) | undefined;
        let ownedModel: Object3D | undefined;
        setFailure(null);
        setLoadedIdentity("");
        const load = async () => {
            const [THREE, { OrbitControls }] = await Promise.all([import("three"), import("three-stdlib")]);
            if (!active) return;
            const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            host.appendChild(renderer.domElement);
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
            camera.position.set(2.7, 1.6, 3.2);
            scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.5));
            const key = new THREE.DirectionalLight(0xffffff, 3);
            key.position.set(3, 5, 4);
            scene.add(key);
            const fill = new THREE.DirectionalLight(0xffffff, 1.5);
            fill.position.set(-3, 1, -2);
            scene.add(fill);
            const controls = new OrbitControls(camera, renderer.domElement);
            controls.enableDamping = false;
            controls.enablePan = false;
            controls.enableZoom = expanded;
            controls.minDistance = 1.3;
            controls.maxDistance = 15;
            const render = () => {
                if (active && !renderer.getContext().isContextLost()) renderer.render(scene, camera);
            };
            const resize = () => {
                const width = Math.max(host.clientWidth, 1);
                const height = Math.max(host.clientHeight, 1);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                renderer.setSize(width, height);
                render();
            };
            const observer = new ResizeObserver(resize);
            observer.observe(host);
            controls.addEventListener("change", render);
            const lost = (event: Event) => {
                event.preventDefault();
                if (active) setFailure({ identity, message: "3D 预览已暂停，请重新加载预览。" });
            };
            renderer.domElement.addEventListener("webglcontextlost", lost);
            controller.current = {
                reset: () => {
                    camera.position.set(2.7, 1.6, 3.2);
                    controls.target.set(0, 0, 0);
                    controls.update();
                    render();
                },
                rotate: (x, y) => {
                    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
                    spherical.theta += x;
                    spherical.phi = THREE.MathUtils.clamp(spherical.phi + y, 0.1, Math.PI - 0.1);
                    camera.position.setFromSpherical(spherical).add(controls.target);
                    controls.update();
                    render();
                },
            };
            cleanup = () => {
                observer.disconnect();
                controls.removeEventListener("change", render);
                controls.dispose();
                renderer.domElement.removeEventListener("webglcontextlost", lost);
                controller.current = null;
                disposePrevisObject3D(ownedModel);
                ownedModel = undefined;
                renderer.dispose();
                renderer.forceContextLoss();
                renderer.domElement.remove();
            };
            resize();
            const resolved = await resolveMediaUrl(storageKey, url);
            if (!active) return;
            if (!resolved) throw new Error("模型资源暂时不可用");
            const model = format === "fbx" ? await createModel3DFBXLoader().loadAsync(resolved) : (await createModel3DGLTFLoader().loadAsync(resolved)).scene;
            if (!active) {
                disposePrevisObject3D(model);
                return;
            }
            ownedModel = model;
            model.updateMatrixWorld(true);
            const bounds = new THREE.Box3().setFromObject(model);
            const size = bounds.getSize(new THREE.Vector3());
            const maximum = Math.max(size.x, size.y, size.z);
            if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("模型没有可预览的几何体");
            const center = bounds.getCenter(new THREE.Vector3());
            const group = new THREE.Group();
            group.add(model);
            model.position.sub(center);
            group.scale.setScalar(2.5 / maximum);
            scene.add(group);
            render();
            setLoadedIdentity(identity);
        };
        void load().catch(() => {
            if (active) {
                setFailure({ identity, message: "模型预览加载失败，可重新加载预览或下载模型。" });
                cleanup?.();
                cleanup = undefined;
            }
        });
        return () => {
            active = false;
            cleanup?.();
        };
    }, [identity, storageKey, url, format, expanded, retry]);

    const error = failure?.identity === identity ? failure.message : "";
    return (
        <div className="relative size-full min-h-32" style={{ background: panel, color: text }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
            <div
                ref={hostRef}
                className="size-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--control-focus-ring)]"
                tabIndex={0}
                aria-label="3D 模型预览，拖拽或使用方向键旋转"
                style={{ touchAction: "none" }}
                onKeyDown={(event) => {
                    const directions: Record<string, [number, number]> = { ArrowLeft: [0.1, 0], ArrowRight: [-0.1, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] };
                    const direction = directions[event.key];
                    if (direction) {
                        event.preventDefault();
                        event.stopPropagation();
                        controller.current?.rotate(...direction);
                    }
                    if (event.key.toLowerCase() === "r") {
                        event.stopPropagation();
                        controller.current?.reset();
                    }
                }}
            />
            {!error && loadedIdentity !== identity ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs" style={{ color: muted }}>
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                    正在加载模型
                </div>
            ) : null}
            {error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center text-xs" style={{ background: panel, color: muted }}>
                    <span role="alert">{error}</span>
                    <button type="button" className="rounded-[var(--r-md)] border px-3 py-2" style={{ borderColor: stroke, color: text }} onClick={() => setRetry((value) => value + 1)}>
                        重新加载预览
                    </button>
                </div>
            ) : null}
            {!error && loadedIdentity === identity ? (
                <>
                    <button type="button" title="重置视角" aria-label="重置视角" className="absolute bottom-2 right-2 rounded-[var(--r-md)] border p-2" style={{ background: panel, borderColor: stroke }} onClick={() => controller.current?.reset()}>
                        <RotateCcw className="size-3.5" />
                    </button>
                    <span className="pointer-events-none absolute bottom-3 left-3 text-[var(--fs-tiny)]" style={{ color: muted }}>
                        拖拽旋转 · 方向键 · R 重置{expanded ? " · 滚轮缩放" : ""}
                    </span>
                </>
            ) : null}
        </div>
    );
}
