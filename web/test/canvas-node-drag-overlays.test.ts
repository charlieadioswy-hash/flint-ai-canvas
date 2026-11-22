import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { ART_CRITIQUE_NODE_TYPE } from "@/lib/art-critique/contracts";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { moduleGroupSource } from "./helpers/module-group-source";

const projectSource = moduleGroupSource("pages/canvas/project.tsx");
const selectionControllerSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-selection-controller.ts"), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

function dragEndEnvironment(node?: CanvasNodeData) {
    const match = projectSource.match(/const handleNodeDragEnd = useCallback\(\s*(\(nodeId: string\) => \{[\s\S]*?\n        \}),\s*\[/);
    if (!match) throw new Error("Missing handleNodeDragEnd callback");
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`const handler = ${match[1]};`);
    let dialogNodeId: string | null = "previous-image";
    const scope = {
        nodesRef: { current: node ? [node] : [] },
        CanvasNodeType,
        ART_CRITIQUE_NODE_TYPE,
        setDialogNodeId: (id: string | null) => {
            dialogNodeId = id;
        },
    };
    const handleNodeDragEnd = new Function(...Object.keys(scope), js + "; return handler;")(...Object.values(scope)) as (nodeId: string) => void;
    return { handleNodeDragEnd, getDialogNodeId: () => dialogNodeId };
}

function node(type: CanvasNodeData["type"], metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "dragged-node", type, title: "拖动测试", position: { x: 0, y: 0 }, width: 500, height: 400, metadata };
}

describe("canvas node drag overlays", () => {
    for (const [label, metadata] of [
        ["分镜组", { frame: { collapsed: false } }],
        ["普通文件夹", { frame: { collapsed: false }, folder: { style: "glass", createdAt: "2026-11-17" } }],
    ] as const) {
        test(`拖动${label}后关闭旧面板，不打开图片生成面板`, () => {
            const dragged = node(CanvasNodeType.Frame, metadata);
            const environment = dragEndEnvironment(dragged);
            environment.handleNodeDragEnd(dragged.id);
            expect(environment.getDialogNodeId()).toBeNull();
        });
    }

    for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Config]) {
        test(`拖动${type}节点后仍绑定本节点编辑面板`, () => {
            const dragged = node(type);
            const environment = dragEndEnvironment(dragged);
            environment.handleNodeDragEnd(dragged.id);
            expect(environment.getDialogNodeId()).toBe(dragged.id);
        });
    }

    for (const dragged of [node(CanvasNodeType.Script), node(CanvasNodeType.Drawing), node(CanvasNodeType.Panorama), node(ART_CRITIQUE_NODE_TYPE), node(CanvasNodeType.Text, { workflowKind: "character", characterAssetId: "character-asset" })]) {
        test(`拖动${dragged.metadata?.workflowKind || dragged.type}节点后保留既有面板排除规则`, () => {
            const environment = dragEndEnvironment(dragged);
            environment.handleNodeDragEnd(dragged.id);
            expect(environment.getDialogNodeId()).toBeNull();
        });
    }

    test("拖动结束时节点已不存在则关闭旧面板", () => {
        const environment = dragEndEnvironment();
        environment.handleNodeDragEnd("removed-node");
        expect(environment.getDialogNodeId()).toBeNull();
    });

    test("hides floating editors and selection controls for the whole drag preview", () => {
        expect(projectSource).toContain("const isCanvasNodeMoving = isNodeDragging || Boolean(dragPreview?.nodeIds.size);");
        // 面板浮层的守卫必须同时成立：类型排除、框选、拖拽预览。断言整段条件而不是某一行的
        // 字面量，避免上游拆行或新增类型排除（Panorama 等）后把排版变化报成契约失效。
        const flatSource = flat(projectSource);
        const overlayStart = flatSource.indexOf("{dialogNode &&");
        const overlayCondition = flatSource.slice(overlayStart, flatSource.indexOf("<CanvasNodePanelOverlay", overlayStart));
        expect(overlayCondition).toContain("dialogNode.type !== CanvasNodeType.Drawing");
        expect(overlayCondition).toContain("dialogNode.type !== CanvasNodeType.Frame");
        expect(overlayCondition).toContain("!selectionBox");
        expect(overlayCondition).toContain("!isCanvasNodeMoving");
        expect(projectSource).not.toContain("angleNode?.metadata?.content && !isCanvasNodeMoving");
        expect(projectSource).toContain("emotionNode?.metadata?.content && !isCanvasNodeMoving");
        expect(projectSource).toContain("selectedNodeBounds && !selectionBox && !isCanvasNodeMoving");
        expect(overlayCondition).toContain("!deferDragOverlays");
        expect(projectSource).toContain("node={isCanvasNodeMoving || deferDragOverlays || nodeImageSettingsOpen || emotionNodeId || angleNodeId ? null : toolbarNode}");
        expect(projectSource).toContain("onNodeDragEnd: handleNodeDragEnd");
        expect(projectSource).toContain("setDialogNodeId(node.id);");
        expect(selectionControllerSource).toContain("if (clickedNodeId) onNodeDragEnd?.(clickedNodeId);");
    });
});
