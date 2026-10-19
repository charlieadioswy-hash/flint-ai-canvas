import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Model3DNodeContent } from "@/components/canvas/nodes/model3d-node";
import { canvasThemes } from "@/lib/canvas-theme";
import { createDefaultModel3DState } from "@/lib/canvas/model3d";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("real 3D node distinguishes saving from completion and hides unmeasured progress", () => {
    for (const theme of [canvasThemes.dark, canvasThemes.light]) {
        const state = createDefaultModel3DState("h3.1");
        const node: CanvasNodeData = { id: "model", title: "3D", type: CanvasNodeType.Model3D, width: 520, height: 420, position: { x: 0, y: 0 }, metadata: { model3d: state } };
        state.run = { requestId: "request", taskId: "task", sourceFingerprint: "fingerprint", snapshot: structuredClone(state.draft), status: "running", stage: "保存 3D 模型文件", progress: 100 };
        const render = () => renderToStaticMarkup(<Model3DNodeContent node={node} theme={theme} />);
        for (const progress of [0, 100]) {
            state.run.progress = progress;
            const html = render();
            expect(html).toContain("正在保存模型");
            expect(html).not.toContain("生成完成");
            expect(html).not.toMatch(/\d+%/);
        }
        state.run.stage = "3D 模型生成中";
        state.run.progress = 100;
        expect(render()).not.toContain("100%");
        state.run.progress = 37;
        expect(render()).toContain("37%");
        state.run.status = "succeeded";
        state.run.stage = "3D 模型已保存";
        state.run.progress = 100;
        expect(render()).not.toContain("生成完成");
        state.result = { assetId: "asset", resourceId: "resource", storageKey: "resource:resource", url: "/api/resources/resource/file", fileName: "model.glb", mimeType: "model/gltf-binary", bytes: 50, format: "glb" };
        expect(render()).toContain("生成完成");
        expect(render()).toContain("模型已就绪");
    }
});
