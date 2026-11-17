import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { applyFrameDrops } from "@/lib/canvas/canvas-frame";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function frame(id: string, x = 0): CanvasNodeData {
    return { id, type: CanvasNodeType.Frame, title: "分镜组", position: { x, y: 0 }, width: 500, height: 400, metadata: { frame: { collapsed: false, expandedWidth: 500, expandedHeight: 400, color: "blue" } } };
}

function image(id: string, x: number, parentId?: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y: 100 }, width: 100, height: 80, parentId, metadata: { content: "resource:image" } };
}

describe("分镜组拖放归属", () => {
    test.each([
        ["stay", "leave"],
        ["leave", "stay"],
    ])("留组与出组同时结算不受顺序影响：%s、%s", (first, second) => {
        const result = applyFrameDrops([frame("group"), image("stay", 200, "group"), image("leave", 550, "group")], new Set([first, second]));
        const group = result.nodes.find((node) => node.id === "group");
        expect(group?.position).toEqual({ x: 0, y: 0 });
        expect(group?.width).toBe(500);
        expect(group?.height).toBe(400);
        expect(group?.metadata?.frame?.expandedWidth).toBe(500);
        expect(result.nodes.find((node) => node.id === "stay")?.parentId).toBe("group");
        expect(result.nodes.find((node) => node.id === "leave")?.parentId).toBeUndefined();
    });

    test.each([
        ["stay", "leave"],
        ["leave", "stay"],
    ])("折叠文件夹按最终成员排布，不移动已转入其他组的元素：%s、%s", (first, second) => {
        const folder = { ...frame("folder"), metadata: { frame: { collapsed: true }, folder: { style: "glass" as const, createdAt: "2026-11-17" } } };
        const result = applyFrameDrops([folder, frame("target", 500), image("stay", 200, "folder"), image("leave", 550, "folder")], new Set([first, second]));
        const settledFolder = result.nodes.find((node) => node.id === "folder");
        expect(settledFolder?.metadata?.frame).toMatchObject({ collapsed: true, expandedWidth: 148, expandedHeight: 164 });
        expect(result.nodes.find((node) => node.id === "stay")).toMatchObject({ parentId: "folder", position: { x: 24, y: 60 } });
        expect(result.nodes.find((node) => node.id === "leave")).toMatchObject({ parentId: "target", position: { x: 550, y: 100 } });
        expect(result.nodes.find((node) => node.id === "target")).toMatchObject({ position: { x: 500, y: 0 }, width: 500, height: 400 });
    });

    test("跨多组结算不会为每个组重新读取所有无关节点的归属", () => {
        const nodes: CanvasNodeData[] = [];
        const draggedIds = new Set<string>();
        for (let groupIndex = 0; groupIndex < 50; groupIndex++) {
            const id = `group-${groupIndex}`;
            const childId = `child-${groupIndex}`;
            nodes.push(frame(id, groupIndex * 900), image(childId, groupIndex * 900 + 100, id));
            draggedIds.add(childId);
        }
        let parentReads = 0;
        const looseCount = 5000;
        for (let index = 0; index < looseCount; index++) {
            const loose = image(`loose-${index}`, 100000 + index * 120);
            Object.defineProperty(loose, "parentId", {
                enumerable: true,
                get() {
                    parentReads++;
                    return undefined;
                },
            });
            nodes.push(loose);
        }
        const result = applyFrameDrops(nodes, draggedIds);
        expect(result.nodes).toHaveLength(nodes.length);
        expect(result.nodes.find((node) => node.id === "child-49")?.parentId).toBe("group-49");
        expect(parentReads).toBeLessThan(looseCount * 8);
    });

    test("多选节点各自按所在区域归属，不因没有共同目标而全部脱组", () => {
        const result = applyFrameDrops([frame("a"), frame("b", 900), image("first", 100, "a"), image("second", 1000, "b"), image("outside", 1600, "a")], new Set(["first", "second", "outside"]));
        expect(result.nodes.find((node) => node.id === "first")?.parentId).toBe("a");
        expect(result.nodes.find((node) => node.id === "second")?.parentId).toBe("b");
        expect(result.nodes.find((node) => node.id === "outside")?.parentId).toBeUndefined();
    });

    test("拖入、拖出和跨组拖动更新关联，颜色在扩容后保留", () => {
        const incoming = image("image", 450);
        const joined = applyFrameDrops([frame("a"), frame("b", 900), incoming], new Set([incoming.id])).nodes;
        expect(joined.find((node) => node.id === incoming.id)?.parentId).toBe("a");
        expect(joined.find((node) => node.id === "a")?.metadata?.frame?.color).toBe("blue");
        const transferred = applyFrameDrops(
            joined.map((node) => (node.id === incoming.id ? { ...node, position: { x: 1000, y: 100 } } : node)),
            new Set([incoming.id]),
        ).nodes;
        expect(transferred.find((node) => node.id === incoming.id)?.parentId).toBe("b");
        const removed = applyFrameDrops(
            transferred.map((node) => (node.id === incoming.id ? { ...node, position: { x: 1600, y: 100 } } : node)),
            new Set([incoming.id]),
        ).nodes;
        expect(removed.find((node) => node.id === incoming.id)?.parentId).toBeUndefined();
    });

    test("拖动组保持子节点归属，也不吸收路过的未拖动节点", () => {
        const nodes = [frame("group"), image("child", 100, "group"), image("loose", 200)];
        const result = applyFrameDrops(nodes, new Set(["group"]));
        expect(result.nodes).toBe(nodes);
        expect(result.nodes.find((node) => node.id === "child")?.parentId).toBe("group");
        expect(result.nodes.find((node) => node.id === "loose")?.parentId).toBeUndefined();
    });

    test("移动中的组不能成为其他主动拖动节点的落点", () => {
        const nodes = [frame("group"), image("child", 100, "group"), image("loose", 200)];
        const result = applyFrameDrops(nodes, new Set(["group", "loose"]));
        expect(result.nodes.find((node) => node.id === "child")?.parentId).toBe("group");
        expect(result.nodes.find((node) => node.id === "loose")?.parentId).toBeUndefined();
    });

    test("素材库文件夹继续只归档，普通文件夹继续保存本地归属", () => {
        const local = { ...frame("local"), metadata: { frame: { collapsed: true }, folder: { style: "glass" as const, createdAt: "2026-11-17" } } };
        const linked = { ...frame("linked", 900), metadata: { frame: { collapsed: true }, folder: { style: "glass" as const, createdAt: "2026-11-17", assetFolderId: "library", projectId: "project" } } };
        const result = applyFrameDrops([local, linked, image("first", 100), image("second", 1000, "old-parent")], new Set(["first", "second"]));
        expect(result.nodes.find((node) => node.id === "first")?.parentId).toBe("local");
        expect(result.nodes.find((node) => node.id === "second")?.parentId).toBe("old-parent");
        expect(result.archives).toHaveLength(1);
        expect(result.archives[0].folder.id).toBe("linked");
        expect(result.archives[0].nodes.map((node) => node.id)).toEqual(["second"]);
    });
});

test("真实拖动控制器保持整组移动与逐节点进出", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-frame-drag.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(output).toContain("0 fail");
    expect(result.exitCode, output).toBe(0);
}, 20000);
