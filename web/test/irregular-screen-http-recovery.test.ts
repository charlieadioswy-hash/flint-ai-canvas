import { expect, test } from "bun:test";
import type { CanvasNodeData } from "../src/types/canvas";
import type { Asset } from "../src/stores/use-asset-store";

type Scenario = "http-screen-generation" | "http-screen-generation-mismatch" | "http-screen-generation-missing";
type Result = { rejection: string; saved?: CanvasNodeData; restored: CanvasNodeData; assets: Asset[]; requests: string[] };

function runScenario(scenario: Scenario): Promise<Result> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/generation-storage-consistency.worker.ts", import.meta.url).href, { type: "module" });
        const finish = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { finish(); reject(new Error("HTTP screen recovery timed out")); }, 15_000);
        worker.onmessage = (event: MessageEvent<{ ok: boolean; result: Result; error?: string }>) => {
            finish();
            if (event.data.ok) resolve(event.data.result);
            else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => { finish(); reject(new Error(event.message)); };
        worker.postMessage(scenario);
    });
}

test("screen recovery on HTTP reads the registered resource without creating another asset or task", async () => {
    const result = await runScenario("http-screen-generation");
    expect(result.rejection).toBe("");
    const identity = "generation_e8a36a9adf905e4dfd72cd164c1f5b412e6464d00dc490e3d988121db742e6e4";
    expect(result.saved?.metadata).toMatchObject({ status: "success", taskId: "task-http-recovery", assetId: identity, storageKey: "resource:http-image", naturalWidth: 640, naturalHeight: 480 });
    expect(result.restored.metadata).toMatchObject(result.saved!.metadata!);
    expect(result.restored.metadata?.generationEffectKeys).toBeUndefined();
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ id: identity, title: "用户已修改标题", tags: ["精选"] });
    expect(result.requests).toContain("post:/assets/batch");
    expect(result.requests).toContain("get:/tasks/task-http-recovery");
    expect(result.requests.some((request) => request.includes("generation-effects") || request === "post:/tasks" || request === "post:/assets" || request === "post:/resources/upload")).toBe(false);
});

for (const variant of ["mismatch", "missing"] as const) test(`HTTP screen recovery refuses a ${variant} registered asset`, async () => {
    const result = await runScenario(`http-screen-generation-${variant}`);
    expect(result.rejection).not.toBe("");
    expect(result.saved).toBeUndefined();
    expect(result.restored.metadata?.assetId).toBeUndefined();
    expect(result.restored.metadata?.status).not.toBe("success");
    expect(result.requests.every((request) => request === "get:/tasks/task-http-recovery" || request === "post:/assets/batch" || request === "post:/resources/access")).toBe(true);
});
