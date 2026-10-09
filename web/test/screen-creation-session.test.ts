import { expect, test } from "bun:test";

import { buildIrregularScreenTemplate } from "../src/lib/canvas/irregular-screen-domain";
import { createScreenCreationSession } from "../src/pages/screen-creation/screen-creation-session";
import { screenTaskNeedsRecovery } from "../src/pages/screen-creation/use-screen-creation";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { CanvasNodeMetadata } from "../src/types/canvas";

test("a disposed form cannot navigate or publish a late upload and leaves the next form active", async () => {
    const revoked: string[] = [];
    const previous = createScreenCreationSession(() => "account-a", (url) => revoked.push(url));
    const capturedSignal = previous.signal;
    previous.ownUrl("blob:original");
    let finish!: (url: string) => void;
    const deferred = new Promise<string>((resolve) => { finish = resolve; });
    let navigations = 0;
    const pending = deferred.then((url) => {
        previous.ownUrl(url);
        previous.assertActive();
        navigations++;
    });
    previous.dispose();
    const next = createScreenCreationSession(() => "account-a", (url) => revoked.push(url));
    next.ownUrl("blob:next-form");
    finish("blob:late-derived-mask");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(navigations).toBe(0);
    expect(capturedSignal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);
    expect(next.isActive()).toBe(true);
    expect(revoked).toEqual(["blob:original", "blob:late-derived-mask"]);
    previous.dispose();
    expect(revoked).not.toContain("blob:next-form");
    next.dispose();
});

test("account changes invalidate callbacks before component cleanup runs", async () => {
    let scope = "account-a";
    const session = createScreenCreationSession(() => scope);
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => { finish = resolve; });
    let writes = 0;
    const pending = deferred.then(() => { session.assertActive(); writes++; });
    scope = "account-b";
    expect(session.signal.aborted).toBe(false);
    expect(session.isActive()).toBe(false);
    finish();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toBe(0);
    session.dispose();
});

test("form-owned blob URLs are released once without revoking saved resource URLs", () => {
    const revoked: string[] = [];
    const session = createScreenCreationSession(() => "account-a", (url) => revoked.push(url));
    session.ownUrl("blob:unused-mask");
    session.releaseUrl("blob:unused-mask");
    session.ownUrl("/api/resources/saved/file");
    session.ownUrl("blob:active-mask");
    session.dispose();
    session.dispose();
    expect(revoked).toEqual(["blob:unused-mask", "blob:active-mask"]);
});

function project(metadata: CanvasNodeMetadata = {}): CanvasProject {
    const template = buildIrregularScreenTemplate({
        controlImage: { storageKey: "resource:original", width: 1024, height: 1024 },
        outputMask: { storageKey: "resource:mask", width: 1024, height: 1024 },
        prompt: "水下世界", size: "1024x1024",
        modelSelection: { kind: "channel", channelId: "screen-channel", modelKey: "screen" },
        controlParameters: { preprocessor: "canny", model: "control-model", strength: 0.9, start: 0, end: 0.9, pixelPerfect: true, controlMode: "balanced", resizeMode: "stretch", canny: { resolution: 1024, lowThreshold: 100, highThreshold: 200 } },
    });
    const generation = template.nodes.find((node) => node.id === template.generationNodeId)!;
    generation.metadata = { ...generation.metadata, ...metadata };
    return { id: "screen-canvas", title: "Screen", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...template };
}

test("queued, uncertain and unmaterialized tasks recover instead of resubmitting edited settings", () => {
    for (const metadata of [
        { status: "loading", taskId: "task-1", taskStatus: "queued" },
        { status: "error", taskClientOperationId: "uncertain-submit" },
        { status: "error", taskId: "task-1", taskStatus: "succeeded" },
    ] satisfies CanvasNodeMetadata[]) {
        expect(screenTaskNeedsRecovery(project(metadata))).toBe(true);
    }
});

test("confirmed failure and cancellation allow a new generation while completed scenes stay idle", () => {
    for (const metadata of [
        {},
        { status: "error" },
        { status: "error", taskId: "task-1", taskClientOperationId: "old", taskStatus: "failed" },
        { status: "error", taskId: "task-1", taskStatus: "cancelled" },
        { status: "success", taskId: "task-1", taskStatus: "succeeded", storageKey: "resource:output", assetId: "asset-1" },
    ] satisfies CanvasNodeMetadata[]) {
        expect(screenTaskNeedsRecovery(project(metadata))).toBe(false);
    }
    expect(screenTaskNeedsRecovery(undefined)).toBe(false);
    expect(screenTaskNeedsRecovery({ ...project(), creationScene: undefined })).toBe(false);
});
