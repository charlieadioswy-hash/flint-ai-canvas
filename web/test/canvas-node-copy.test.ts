import { describe, expect, test } from "bun:test";

import { isolateCopiedNodeMetadata, nextCopiedNodeTitle } from "@/lib/canvas/canvas-node-copy";
import { imageGenerationTargetsForSource, reconcileImageGenerationNodes } from "@/lib/canvas/canvas-image-batch-retry";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { useCanvasStore, withCanvasStorePersistenceSuppressed } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

describe("canvas node copy title", () => {
    test("首次复制使用 copy1，后续按已有最大序号递增", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图"])).toBe("女明星角色三视图_copy1");
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图", "女明星角色三视图_copy1"])).toBe("女明星角色三视图_copy2");
        expect(nextCopiedNodeTitle("女明星角色三视图", ["女明星角色三视图_copy1", "女明星角色三视图_copy3"])).toBe("女明星角色三视图_copy4");
    });

    test("复制已有副本时仍使用原始名称计算下一序号", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图_copy1", ["女明星角色三视图", "女明星角色三视图_copy1"])).toBe("女明星角色三视图_copy2");
    });

    test("兼容旧版空格 Copy 后缀", () => {
        expect(nextCopiedNodeTitle("女明星角色三视图 Copy", ["女明星角色三视图", "女明星角色三视图 Copy"])).toBe("女明星角色三视图_copy1");
    });

    test("同一批粘贴可以通过预留标题连续分配序号", () => {
        const titles = new Set(["节点", "节点_copy1"]);
        const first = nextCopiedNodeTitle("节点", titles);
        titles.add(first);
        const second = nextCopiedNodeTitle("节点", titles);
        expect([first, second]).toEqual(["节点_copy2", "节点_copy3"]);
    });
});

describe("canvas generation copy metadata", () => {
    for (const includeOutput of [false, true]) {
        test(`Config 副本清除原生成批次身份（${includeOutput ? "连同输出复制" : "单独复制"}）`, () => {
            const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { status: "loading", imageGenerationRootId: "output", prompt: "原提示词" } };
            const output: CanvasNodeData = { ...source, id: "output", type: CanvasNodeType.Image, metadata: { status: "loading", generationType: "generation", taskId: "original-task" } };
            const idMap = new Map([[source.id, "source-copy"], ...(includeOutput ? [[output.id, "output-copy"]] : [])]);
            const copy = { ...source, id: "source-copy", metadata: isolateCopiedNodeMetadata(source, idMap) };
            expect(copy.metadata).toMatchObject({ status: "idle", prompt: "原提示词" });
            expect(copy.metadata.imageGenerationRootId).toBeUndefined();
            expect(imageGenerationTargetsForSource(copy, [source, output, copy])).toEqual([]);
            expect(source.metadata?.imageGenerationRootId).toBe(output.id);
        });
    }

    test("整画布导入保留本图节点 ID，生成身份仅解析导入画布内的输出", () => {
        const originalProjects = useCanvasStore.getState().projects;
        const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { status: "loading", imageGenerationRootId: "output" } };
        const output: CanvasNodeData = { ...source, id: "output", type: CanvasNodeType.Image, metadata: { status: "loading", generationType: "generation" } };
        try {
            const originalId = withCanvasStorePersistenceSuppressed(() => useCanvasStore.getState().importProject({ nodes: [source, output] }));
            const original = useCanvasStore.getState().openProject(originalId)!;
            const importedId = withCanvasStorePersistenceSuppressed(() => useCanvasStore.getState().importProject(structuredClone(original)));
            const imported = useCanvasStore.getState().openProject(importedId)!;
            expect(importedId).not.toBe(originalId);
            expect(imageGenerationTargetsForSource(imported.nodes[0], imported.nodes)).toEqual([imported.nodes[1]]);
            const completed = imported.nodes.map((node) => (node.id === output.id ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "/imported.png" } } : node));
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.getState().updateProject(importedId, { nodes: reconcileImageGenerationNodes(completed) }));
            expect(useCanvasStore.getState().openProject(importedId)?.nodes[0].metadata?.status).toBe("success");
            expect(useCanvasStore.getState().openProject(originalId)?.nodes[0].metadata?.status).toBe("loading");
            expect(original.nodes[1].metadata?.content).toBeUndefined();
        } finally {
            withCanvasStorePersistenceSuppressed(() => useCanvasStore.setState({ projects: originalProjects }));
        }
    });

    test("预演副本只保留本次复制的预览、深度和法线节点引用", () => {
        const source: CanvasNodeData = {
            id: "previs",
            type: CanvasNodeType.Text,
            title: "预演镜头",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: {
                previsPreviewNodeId: "preview",
                previsDepthNodeId: "depth",
                previsNormalNodeId: "normal",
            },
        };

        const metadata = isolateCopiedNodeMetadata(
            source,
            new Map([
                ["preview", "preview-copy"],
                ["normal", "normal-copy"],
            ]),
        );

        expect(metadata.previsPreviewNodeId).toBe("preview-copy");
        expect(metadata.previsDepthNodeId).toBeUndefined();
        expect(metadata.previsNormalNodeId).toBe("normal-copy");
        expect(source.metadata?.previsPreviewNodeId).toBe("preview");
        expect(source.metadata?.previsDepthNodeId).toBe("depth");
        expect(source.metadata?.previsNormalNodeId).toBe("normal");
    });

    test("媒体副本保留提示词与参考字段，并明确原地回填生成结果", () => {
        const source: CanvasNodeData = {
            id: "source",
            type: CanvasNodeType.Video,
            title: "镜头",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: {
                content: "video-url",
                prompt: "相同提示词",
                videoStartFrameNodeId: "reference-start",
                videoEndFrameNodeId: "reference-end",
                generationResultPlacement: "new-version",
                generationEffectKeys: ["attach-node:source-task:source:0"],
            },
        };

        const metadata = isolateCopiedNodeMetadata(source, new Map([[source.id, "copy"]]));

        expect(metadata.prompt).toBe("相同提示词");
        expect(metadata.videoStartFrameNodeId).toBe("reference-start");
        expect(metadata.videoEndFrameNodeId).toBe("reference-end");
        expect(metadata.copiedFromNodeId).toBe("source");
        expect(metadata.generationResultPlacement).toBe("replace-node");
        expect(metadata.generationEffectKeys).toBeUndefined();
        expect(source.metadata?.generationEffectKeys).toEqual(["attach-node:source-task:source:0"]);
    });

    test("复制到副本的入边继续解析为同一张参考图", () => {
        const reference: CanvasNodeData = {
            id: "reference",
            type: CanvasNodeType.Image,
            title: "角色参考",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "reference-url", mimeType: "image/png" },
        };
        const copy: CanvasNodeData = {
            id: "copy",
            type: CanvasNodeType.Image,
            title: "结果_copy1",
            position: { x: 400, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "old-result", prompt: "保持角色一致", copiedFromNodeId: "source", generationResultPlacement: "replace-node" },
        };

        const context = buildNodeGenerationContext(copy.id, [reference, copy], [{ id: "copy-reference", fromNodeId: reference.id, toNodeId: copy.id }], copy.metadata!.prompt!, []);

        expect(context.prompt).toBe("保持角色一致");
        expect(context.referenceImages.map((image) => image.id)).toEqual([reference.id]);
    });
});

describe("batch table copy references", () => {
    const table: CanvasNodeData = {
        id: "table",
        type: CanvasNodeType.BatchTable,
        title: "批量创作",
        position: { x: 0, y: 0 },
        width: 1280,
        height: 560,
        metadata: {
            batchTable: {
                operation: "creative",
                concurrency: 2,
                referenceMode: "cells",
                aiGenerated: true,
                referenceColumns: [
                    { id: "portrait", label: "人物" },
                    { id: "scene", label: "场景" },
                    { id: "style", label: "风格" },
                ],
                textColumns: [{ id: "requirements", label: "要求", type: "text" }],
                rows: [
                    {
                        id: "row-1",
                        enabled: true,
                        inputNodeIds: ["portrait-image", "", "portrait-image"],
                        textNodeIds: ["note"],
                        prompt: "保持人物一致",
                        outputNodeId: "result",
                        generatedInputSignature: "old-generation",
                        cells: { requirements: "近景" },
                    },
                ],
            },
        },
    };

    test("只复制表格保留外部素材及空列，但不接管原表的生成结果", () => {
        const metadata = isolateCopiedNodeMetadata(table, new Map([["table", "table-copy"]]));
        const copied = metadata.batchTable!;

        expect(copied.referenceMode).toBe("cells");
        expect(copied.rows[0].inputNodeIds).toEqual(["portrait-image", "", "portrait-image"]);
        expect(copied.rows[0].textNodeIds).toEqual(["note"]);
        expect(copied.rows[0].outputNodeId).toBeUndefined();
        expect(copied.rows[0].generatedInputSignature).toBeUndefined();
        expect(table.metadata?.batchTable?.rows[0].outputNodeId).toBe("result");
        expect(table.metadata?.batchTable?.rows[0].generatedInputSignature).toBe("old-generation");
    });

    test("同时复制表、素材和结果后，列位置、格子与输出归属全部指向同组副本", () => {
        const idMap = new Map([
            ["table", "table-copy"],
            ["portrait-image", "portrait-copy"],
            ["note", "note-copy"],
            ["result", "result-copy"],
        ]);
        const copied = isolateCopiedNodeMetadata(table, idMap).batchTable!;
        const result: CanvasNodeData = {
            id: "result",
            type: CanvasNodeType.Image,
            title: "成品",
            position: { x: 1400, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "result.png", batchSourceNodeId: "table", batchRowId: "row-1", batchOperation: "creative", batchInputNodeIds: ["portrait-image", "", "portrait-image"] },
        };
        const copiedResult = isolateCopiedNodeMetadata(result, idMap);

        expect(copied.rows[0].id).toBe("row-1");
        expect(copied.referenceColumns?.map((column) => column.id)).toEqual(["portrait", "scene", "style"]);
        expect(copied.rows[0].inputNodeIds).toEqual(["portrait-copy", "", "portrait-copy"]);
        expect(copied.rows[0].textNodeIds).toEqual(["note-copy"]);
        expect(copied.rows[0].outputNodeId).toBe("result-copy");
        expect(copiedResult.batchSourceNodeId).toBe("table-copy");
        expect(copiedResult.batchRowId).toBe("row-1");
        expect(copiedResult.batchInputNodeIds).toEqual(["portrait-copy", "", "portrait-copy"]);

        copied.referenceColumns![0].label = "副本人物";
        copied.rows[0].cells!.requirements = "远景";
        copied.rows[0].inputNodeIds[0] = "new-image";
        expect(table.metadata?.batchTable?.referenceColumns?.[0].label).toBe("人物");
        expect(table.metadata?.batchTable?.rows[0].cells?.requirements).toBe("近景");
        expect(table.metadata?.batchTable?.rows[0].inputNodeIds[0]).toBe("portrait-image");
    });

    test("单独复制成品不再归属原任务行，仍保留素材引用", () => {
        const result: CanvasNodeData = {
            id: "result",
            type: CanvasNodeType.Image,
            title: "成品",
            position: { x: 0, y: 0 },
            width: 340,
            height: 240,
            metadata: { content: "result.png", batchSourceNodeId: "table", batchRowId: "row-1", batchOperation: "creative", batchInputNodeIds: ["portrait-image"] },
        };
        const copied = isolateCopiedNodeMetadata(result, new Map([["result", "result-copy"]]));

        expect(copied.batchSourceNodeId).toBeUndefined();
        expect(copied.batchRowId).toBeUndefined();
        expect(copied.batchOperation).toBeUndefined();
        expect(copied.batchInputNodeIds).toEqual(["portrait-image"]);
        expect(copied.content).toBe("result.png");
    });
});
