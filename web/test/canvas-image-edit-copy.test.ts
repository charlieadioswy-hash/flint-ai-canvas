import { expect, test } from "bun:test";
import { createCanvasImageEditCopy } from "@/lib/canvas/canvas-image-edit-copy";
import { applyCanvasImageRotation } from "@/lib/canvas/canvas-image-rotation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
const source: CanvasNodeData = {
    id: "original",
    type: CanvasNodeType.Image,
    title: "原图",
    position: { x: 20, y: 40 },
    width: 360,
    height: 240,
    metadata: { storageKey: "resource:original", content: "/api/resources/original", naturalWidth: 1200, naturalHeight: 800, batchSourceNodeId: "table", batchRowId: "row", taskId: "old-task" },
};
test("edit copy leaves source and task ownership intact, links the new node, and rotates that copy", () => {
    const copy = createCanvasImageEditCopy(source, [source])!;
    expect(copy.node.metadata).toMatchObject({ imageEditSourceNodeId: "original", storageKey: "resource:original" });
    expect(copy.node.metadata?.batchSourceNodeId).toBeUndefined();
    expect(copy.node.metadata?.batchRowId).toBeUndefined();
    expect(copy.node.metadata?.taskId).toBeUndefined();
    expect(copy.connection).toMatchObject({ fromNodeId: "original", toNodeId: copy.node.id });
    const turned = applyCanvasImageRotation(copy.node, {
        original: { content: "/original", storageKey: "resource:original", width: 1200, height: 800 },
        quarterTurns: 1,
        variants: { 1: { content: "/rotated", storageKey: "resource:rotated", width: 800, height: 1200 } },
    });
    expect(turned.id).toBe(copy.node.id);
    expect(turned.metadata?.storageKey).toBe("resource:rotated");
    expect(turned.metadata?.imageEditSourceNodeId).toBe("original");
    expect(source.metadata?.storageKey).toBe("resource:original");
    expect(source.metadata?.batchRowId).toBe("row");
    expect([turned.width, turned.height]).toEqual([240, 360]);
});
test("copy refuses locked, uploading, loading and empty nodes; a copy starts at visible orientation", () => {
    for (const metadata of [{ ...source.metadata, locked: true }, { ...source.metadata, status: "loading" as const }, {}]) expect(createCanvasImageEditCopy({ ...source, metadata }, [source])).toBeUndefined();
    const copied = createCanvasImageEditCopy({ ...source, metadata: { ...source.metadata, imageRotation: { quarterTurns: 1, original: { content: "/old", width: 800, height: 1200 } } } }, [source])!;
    expect(copied.node.metadata?.imageRotation).toBeUndefined();
});
