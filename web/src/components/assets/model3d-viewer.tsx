import { useEffect, useRef, useState } from "react";
import { Axis3D, Bone, Boxes, Grid2X2, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import type { Bone as ThreeBone, Box3, GridHelper, Object3D, SkeletonHelper } from "three";

import { IconButton, ToolButton } from "@/components/ui/base/buttons";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { getActiveUserScope } from "@/lib/user-scope";
import { disposePrevisObject3D } from "@/lib/canvas/previs/previs-resources";
import { loadModel3D } from "@/lib/canvas/model3d-preview";
import type { Model3DPreviewFormat } from "@/lib/model3d-formats";
import { createModel3DGround, MODEL3D_AXES, projectModel3DAxes } from "./model3d-viewer-helpers";
import { createModel3DPlayback, model3DPartObjects } from "./model3d-playback";
import { createModel3DPartsLayout, frameModel3DParts } from "./model3d-parts-layout";

type Props = { storageKey?: string; url: string; format: Model3DPreviewFormat; theme?: CanvasTheme; expanded?: boolean; partNames?: string[] };

/** Mounted only after entering preview; controls render on demand and own their GPU resources. */
export function Model3DViewer({ storageKey, url, format, theme, expanded = false, partNames }: Props) {
    const hostRef = useRef<HTMLDivElement>(null);
    const partsToolsRef = useRef<HTMLDivElement>(null);
    const axesRef = useRef<SVGSVGElement>(null);
    const gridVisibleRef = useRef(true);
    const controller = useRef<{
        reset: () => void;
        rotate: (x: number, y: number) => void;
        setGridVisible: (visible: boolean) => void;
        setSkeletonVisible: (visible: boolean) => void;
        setPartVisible: (id: string, visible: boolean) => void;
        setPartsSeparated: (value: boolean) => void;
        updateAppearance: () => void;
    } | null>(null);
    const playback = useRef<ReturnType<typeof createModel3DPlayback> | null>(null);
    const partsKey = JSON.stringify(partNames || []);
    const identity = `${getActiveUserScope()}:${storageKey || url}:${format}`;
    const panel = theme?.node.panel || "var(--background)";
    const text = theme?.node.text || "var(--foreground)";
    const muted = theme?.node.muted || "var(--muted-foreground)";
    const stroke = theme?.node.stroke || "var(--border)";
    const [retry, setRetry] = useState(0);
    const [loadedIdentity, setLoadedIdentity] = useState("");
    const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
    const [showGrid, setShowGrid] = useState(true);
    const [showAxes, setShowAxes] = useState(true);
    const [showSkeleton, setShowSkeleton] = useState(false);
    const [hasSkeleton, setHasSkeleton] = useState(false);
    const [parts, setParts] = useState<Array<{ id: string; name: string; visible: boolean }>>([]);
    const [separated, setSeparated] = useState(false);
    const [clips, setClips] = useState<Array<{ name: string; duration: number }>>([]);
    const [animation, setAnimation] = useState({ index: 0, playing: false, time: 0, duration: 0 });
    const [speed, setSpeed] = useState(1);

    useEffect(() => {
        controller.current?.updateAppearance();
    }, [muted]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let active = true;
        const abort = new AbortController();
        let cleanup: (() => void) | undefined;
        let ownedModel: Object3D | undefined;
        let ground: GridHelper | undefined;
        let skeleton: SkeletonHelper | undefined;
        let partObjects: ReturnType<typeof model3DPartObjects> = [];
        setFailure(null);
        setLoadedIdentity("");
        setClips([]);
        setParts([]);
        setSeparated(false);
        setHasSkeleton(false);
        setShowSkeleton(false);
        setAnimation({ index: 0, playing: false, time: 0, duration: 0 });
        setSpeed(1);
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
            const assembledView = { position: camera.position.clone(), target: controls.target.clone() };
            let partsSeparated = false;
            let layoutParts: ((value: boolean) => void) | undefined;
            let frameParts: (() => void) | undefined;
            controls.enableDamping = false;
            controls.enablePan = false;
            controls.enableZoom = expanded;
            controls.minDistance = 1.3;
            controls.maxDistance = 15;
            const axisElements = MODEL3D_AXES.map((axis) => ({
                line: axesRef.current?.querySelector<SVGLineElement>(`[data-axis-line="${axis}"]`),
                negative: axesRef.current?.querySelector<SVGLineElement>(`[data-axis-negative="${axis}"]`),
                label: axesRef.current?.querySelector<SVGGElement>(`[data-axis-label="${axis}"]`),
            }));
            const render = () => {
                if (!active || renderer.getContext().isContextLost()) return;
                renderer.render(scene, camera);
                // Update the tiny SVG with the same demand-driven draw, without a React render per drag.
                projectModel3DAxes(camera.quaternion).forEach(({ x, y, depth }, index) => {
                    const { line, negative, label } = axisElements[index];
                    line?.setAttribute("x2", String(44 + x * 28));
                    line?.setAttribute("y2", String(44 + y * 28));
                    negative?.setAttribute("x2", String(44 - x * 18));
                    negative?.setAttribute("y2", String(44 - y * 18));
                    label?.setAttribute("transform", `translate(${44 + x * 28} ${44 + y * 28})`);
                    label?.setAttribute("opacity", depth < -0.1 ? "0.7" : "1");
                });
            };
            const colorSample = document.createElement("canvas");
            colorSample.width = colorSample.height = 1;
            const colorContext = colorSample.getContext("2d", { willReadFrequently: true });
            const updateAppearance = () => {
                if (!ground || !colorContext) return;
                // Canvas resolves CSS tokens (including oklch) to the sRGB values Three accepts.
                colorContext.clearRect(0, 0, 1, 1);
                colorContext.fillStyle = getComputedStyle(host).color;
                colorContext.fillRect(0, 0, 1, 1);
                const [r, g, b] = colorContext.getImageData(0, 0, 1, 1).data;
                ground.material.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
                render();
            };
            const resize = () => {
                const width = Math.max(host.clientWidth, 1);
                const height = Math.max(host.clientHeight, 1);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                renderer.setSize(width, height);
                if (partsSeparated) frameParts?.();
                render();
            };
            const observer = new ResizeObserver(resize);
            observer.observe(host);
            const appearanceObserver = new MutationObserver(updateAppearance);
            appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
            appearanceObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
            controls.addEventListener("change", render);
            let inView = true;
            const syncVisibility = () => playback.current?.setVisible(!document.hidden && inView);
            const visibilityObserver = new IntersectionObserver(([entry]) => {
                inView = entry.isIntersecting;
                syncVisibility();
            });
            visibilityObserver.observe(host);
            document.addEventListener("visibilitychange", syncVisibility);
            const lost = (event: Event) => {
                event.preventDefault();
                playback.current?.pause();
                if (active) setFailure({ identity, message: "3D 预览已暂停，请重新加载预览。" });
            };
            renderer.domElement.addEventListener("webglcontextlost", lost);
            controller.current = {
                reset: () => {
                    camera.position.set(2.7, 1.6, 3.2);
                    controls.target.set(0, 0, 0);
                    controls.update();
                    if (partsSeparated) {
                        frameParts?.();
                        return;
                    }
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
                setGridVisible: (visible) => {
                    if (ground) ground.visible = visible;
                    render();
                },
                setSkeletonVisible: (visible) => {
                    if (skeleton) skeleton.visible = visible;
                    render();
                },
                setPartVisible: (id, visible) => {
                    const part = partObjects.find((value) => value.id === id);
                    if (part) part.object.visible = visible;
                    render();
                },
                setPartsSeparated: (value) => {
                    if (value && !partsSeparated) {
                        assembledView.position.copy(camera.position);
                        assembledView.target.copy(controls.target);
                    }
                    partsSeparated = value;
                    playback.current?.pause();
                    layoutParts?.(value);
                    frameParts?.();
                },
                updateAppearance,
            };
            cleanup = () => {
                visibilityObserver.disconnect();
                document.removeEventListener("visibilitychange", syncVisibility);
                playback.current?.dispose();
                playback.current = null;
                observer.disconnect();
                appearanceObserver.disconnect();
                controls.removeEventListener("change", render);
                controls.dispose();
                renderer.domElement.removeEventListener("webglcontextlost", lost);
                controller.current = null;
                disposePrevisObject3D(skeleton);
                skeleton = undefined;
                disposePrevisObject3D(ownedModel);
                ownedModel = undefined;
                disposePrevisObject3D(ground);
                ground = undefined;
                scene.clear();
                colorSample.width = colorSample.height = 0;
                renderer.dispose();
                renderer.forceContextLoss();
                renderer.domElement.remove();
            };
            resize();
            const model = await loadModel3D({ storageKey, url, format }, abort.signal);
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
            const pivot = new THREE.Group();
            pivot.position.copy(center).negate();
            pivot.add(model);
            group.add(pivot);
            group.scale.setScalar(2.5 / maximum);
            scene.add(group);
            group.updateMatrixWorld(true);
            ground = createModel3DGround(new THREE.Box3().setFromObject(group), new THREE.Color());
            ground.visible = gridVisibleRef.current;
            scene.add(ground);
            let boneCount = 0;
            model.traverse((object) => {
                if ((object as ThreeBone).isBone) boneCount++;
            });
            if (boneCount > 0) {
                skeleton = new THREE.SkeletonHelper(model);
                skeleton.visible = false;
                scene.add(skeleton);
                setHasSkeleton(true);
            }
            partObjects = model3DPartObjects(model, JSON.parse(partsKey) as string[]);
            layoutParts = createModel3DPartsLayout(partObjects);
            frameParts = () => {
                const bounds = new THREE.Box3().setFromObject(group);
                if (partsSeparated) {
                    const meshBounds: Box3[] = [];
                    group.traverse((object) => {
                        if (object instanceof THREE.Mesh) meshBounds.push(new THREE.Box3().setFromObject(object));
                    });
                    const { center, distance } = frameModel3DParts(camera, meshBounds.length ? meshBounds : [bounds], Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), partsToolsRef.current?.offsetHeight || 0);
                    controls.maxDistance = Math.max(15, distance * 3);
                    controls.target.copy(center);
                } else {
                    camera.clearViewOffset();
                    camera.position.copy(assembledView.position);
                    controls.target.copy(assembledView.target);
                    controls.maxDistance = 15;
                    camera.far = 100;
                }
                camera.updateProjectionMatrix();
                controls.update();
                if (ground) {
                    scene.remove(ground);
                    disposePrevisObject3D(ground);
                }
                ground = createModel3DGround(bounds, new THREE.Color());
                ground.visible = gridVisibleRef.current;
                scene.add(ground);
                updateAppearance();
                render();
            };
            setParts(partObjects.map(({ id, name, object }) => ({ id, name, visible: object.visible })));
            playback.current = createModel3DPlayback(model, render, (state) => {
                if (active) setAnimation(state);
            });
            setClips(playback.current.clips);
            if (playback.current.clips.length) playback.current.select(0);
            syncVisibility();
            updateAppearance();
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
            abort.abort();
            cleanup?.();
        };
    }, [identity, storageKey, url, format, expanded, retry, partsKey]);

    const error = failure?.identity === identity ? failure.message : "";
    return (
        <div
            className="relative size-full min-h-32"
            data-canvas-no-zoom={expanded || undefined}
            style={{ background: panel, color: text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={expanded ? (event) => event.stopPropagation() : undefined}
        >
            <div
                ref={hostRef}
                className="size-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--control-focus-ring)]"
                tabIndex={0}
                aria-label="3D 模型预览，拖拽或使用方向键旋转"
                style={{ touchAction: "none", color: muted }}
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
            <svg ref={axesRef} viewBox="0 0 88 88" role="img" aria-label="XYZ 方向指示，与模型视角同步" className={`pointer-events-none absolute right-2 top-2 size-20 select-none ${showAxes && !error && loadedIdentity === identity ? "" : "invisible"}`}>
                <title>XYZ 世界方向；虚线表示负方向</title>
                {MODEL3D_AXES.map((axis) => (
                    <g key={axis} style={{ color: `var(--status-${axis === "X" ? "error" : axis === "Y" ? "success" : "loading"})` }}>
                        <line data-axis-negative={axis} x1="44" y1="44" x2="44" y2="44" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.6" />
                        <line data-axis-line={axis} x1="44" y1="44" x2="44" y2="44" stroke="currentColor" strokeWidth="2" />
                        <g data-axis-label={axis} transform="translate(44 44)">
                            <circle r="8" fill={panel} stroke="currentColor" strokeWidth="1.5" />
                            <text textAnchor="middle" dominantBaseline="central" fill="currentColor" className="text-[var(--fs-tiny)] font-semibold">
                                {axis}
                            </text>
                        </g>
                    </g>
                ))}
            </svg>
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
                    <div ref={partsToolsRef} className="absolute left-2 top-2 flex max-w-[calc(100%-6rem)] flex-col items-start gap-2" data-canvas-no-zoom>
                        <div role="group" aria-label="3D 辅助显示" className="flex flex-wrap gap-1 rounded-[var(--r-md)] border p-1" style={{ background: panel, borderColor: stroke }}>
                            <ToolButton
                                size="sm"
                                icon={<Grid2X2 />}
                                label="网格"
                                active={showGrid}
                                aria-pressed={showGrid}
                                aria-label="显示地面网格"
                                title="地面网格仅作方向参考，不代表实际尺寸"
                                onClick={() => {
                                    const visible = !showGrid;
                                    gridVisibleRef.current = visible;
                                    setShowGrid(visible);
                                    controller.current?.setGridVisible(visible);
                                }}
                            />
                            <ToolButton size="sm" icon={<Axis3D />} label="坐标" active={showAxes} aria-pressed={showAxes} aria-label="显示 XYZ 方向指示" onClick={() => setShowAxes((value) => !value)} />
                            {hasSkeleton ? (
                                <ToolButton
                                    size="sm"
                                    icon={<Bone />}
                                    label="骨骼"
                                    active={showSkeleton}
                                    aria-pressed={showSkeleton}
                                    onClick={() => {
                                        setShowSkeleton(!showSkeleton);
                                        controller.current?.setSkeletonVisible(!showSkeleton);
                                    }}
                                />
                            ) : null}
                            {parts.length > 1 && clips.length === 0 ? (
                                <ToolButton
                                    size="sm"
                                    icon={<Boxes />}
                                    label={separated ? "还原组装" : "分离展示"}
                                    active={separated}
                                    aria-pressed={separated}
                                    title="保持原有结构与朝向，拉开部件间隙；仅影响预览"
                                    onClick={() => {
                                        const value = !separated;
                                        setSeparated(value);
                                        controller.current?.setPartsSeparated(value);
                                    }}
                                />
                            ) : null}
                        </div>
                        {parts.length > 0 ? (
                            <details
                                className="max-w-full rounded-[var(--r-md)] border p-2 text-[var(--fs-caption)]"
                                style={{ background: panel, borderColor: stroke }}
                                onToggle={() => {
                                    if (separated) controller.current?.setPartsSeparated(true);
                                }}
                            >
                                <summary className="cursor-pointer">部件显隐 · {parts.length}</summary>
                                <div className="mt-2 grid max-h-40 gap-2 overflow-auto" data-canvas-wheel-scroll>
                                    {parts.map((part) => (
                                        <label key={part.id} className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                checked={part.visible}
                                                onChange={(event) => {
                                                    const visible = event.target.checked;
                                                    controller.current?.setPartVisible(part.id, visible);
                                                    setParts((current) => current.map((item) => (item.id === part.id ? { ...item, visible } : item)));
                                                }}
                                            />
                                            <span className="truncate" title={part.name}>
                                                {part.name}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </details>
                        ) : null}
                    </div>
                    {clips.length > 0 ? (
                        <div className="absolute bottom-10 left-2 right-2 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border p-2 text-[var(--fs-caption)]" style={{ background: panel, borderColor: stroke }} data-canvas-no-zoom>
                            <IconButton
                                icon={animation.playing ? Pause : Play}
                                aria-label={animation.playing ? "暂停动画" : "播放动画"}
                                title={animation.playing ? "暂停动画" : "播放动画"}
                                onClick={() => {
                                    if (animation.playing) playback.current?.pause();
                                    else playback.current?.play();
                                }}
                            />
                            <select aria-label="预览动作" className="min-w-0 max-w-[40%] bg-transparent" value={animation.index} onChange={(event) => playback.current?.select(Number(event.target.value))}>
                                {clips.map((clip, i) => (
                                    <option key={i} value={i}>
                                        {clip.name}
                                    </option>
                                ))}
                            </select>
                            <input aria-label="动画进度" className="min-w-16 flex-1" type="range" min={0} max={animation.duration || 1} step={0.01} value={animation.time} onChange={(event) => playback.current?.seek(Number(event.target.value))} />
                            <span>
                                {animation.time.toFixed(1)} / {animation.duration.toFixed(1)}s
                            </span>
                            <select
                                aria-label="播放速度"
                                className="bg-transparent"
                                value={speed}
                                onChange={(event) => {
                                    const value = Number(event.target.value);
                                    setSpeed(value);
                                    playback.current?.setSpeed(value);
                                }}
                            >
                                {[0.5, 1, 1.5, 2].map((value) => (
                                    <option key={value} value={value}>
                                        {value}×
                                    </option>
                                ))}
                            </select>
                        </div>
                    ) : null}
                    <IconButton
                        icon={RotateCcw}
                        variant="outline"
                        title="重置视角"
                        aria-label="重置视角"
                        data-canvas-no-zoom
                        className="absolute bottom-2 right-2"
                        style={{ background: panel, borderColor: stroke, color: text }}
                        onClick={() => controller.current?.reset()}
                    />
                    <span className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-4rem)] text-[var(--fs-tiny)]" style={{ color: muted }}>
                        拖拽旋转 · 方向键 · R 重置{expanded ? " · 滚轮缩放" : ""}
                    </span>
                </>
            ) : null}
        </div>
    );
}
