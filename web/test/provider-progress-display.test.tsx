import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskGridCard } from "@/pages/tasks/task-grid-card";
import { LoadingContent } from "@/components/canvas/canvas-node-status-content";
import { canvasThemes } from "@/lib/canvas-theme";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { canvasPersistentNodes } from "@/lib/canvas/canvas-persistent-nodes";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const task: GenerationTask = { id: "task", type: "canvas_image", status: "running", stage: "上游生成中", progress: 35, prompt: "test", attempts: 1, createdAt: "", updatedAt: "" };

test("task card and canvas node show measured zero and remove stale percentages", () => {
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 300, height: 300 };
    for (const theme of [canvasThemes.light, canvasThemes.dark]) {
        for (const providerProgress of [undefined, 0, 37]) {
            const current = { ...task, providerProgress };
            node.metadata = { ...node.metadata, ...generationTaskMetadata(current), status: "loading" };
            const card = renderToStaticMarkup(<TaskGridCard task={current} actingId="" onOpen={() => {}} onRetry={() => {}} />);
            const loading = renderToStaticMarkup(<LoadingContent node={node} theme={theme} />);
            for (const html of [card, loading]) {
                expect(html).toContain("作品创作中");
                expect(html).not.toContain("35%");
                if (providerProgress !== undefined) expect(html).toContain(`${providerProgress}%`);
                else expect(html).not.toMatch(/\d+%/);
            }
            expect(card.includes('role="progressbar"')).toBe(providerProgress !== undefined);
        }
        node.metadata = { ...node.metadata, ...generationTaskMetadata(task) };
        expect(node.metadata.taskProviderProgress).toBeUndefined();
        expect(renderToStaticMarkup(<LoadingContent node={node} theme={theme} />)).not.toContain("37%");
        const saving = { ...task, providerProgress: 99, mediaStage: "upload" as const };
        const html = renderToStaticMarkup(<TaskGridCard task={saving} actingId="" onOpen={() => {}} onRetry={() => {}} />);
        expect(html).toContain("作品已生成，正在保存");
        expect(html).not.toContain("99%");
    }
});

test("polling a provider percentage does not dirty the durable canvas", () => {
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { ...generationTaskMetadata({ ...task, providerProgress: 0 }), status: "loading" } };
    const saved = canvasPersistentNodes([node]);
    expect(saved[0].metadata?.taskProviderProgress).toBeUndefined();
    const updated = { ...node, metadata: { ...node.metadata, taskProviderProgress: 51 } };
    expect(canvasPersistentNodes([updated], saved)).toBe(saved);
});
