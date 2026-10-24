import { expect, test } from "bun:test";

for (const pendingEdit of [false, true]) test(`ZIP model registration retry finishes sync${pendingEdit ? " and preserves unsubmitted editor input" : ""}`, async () => {
    // Isolate the real stores and their permanent auto-sync subscriptions.
    const child = Bun.spawn([process.execPath, "run", "test/helpers/canvas-import-sync-retry.worker.ts", pendingEdit ? "edited" : "unchanged"], {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.assetAttempts).toBe(4);
    expect(result.canvasWrites).toBe(1);
    expect(result.remoteRevision).toBe(1);
    expect(result.nodeCounts).toEqual({ editor: 2, local: 2, remote: 2 });
    expect(result.bindings).toEqual([result.assetId, result.assetId, result.assetId]);
    expect(result.resultBindings).toEqual(result.bindings);
    expect(result.titles).toEqual(Array(3).fill(pendingEdit ? "Edited during retry" : "Text"));
    expect(result.progress).toMatchObject({ phase: "done", localPhase: "saved", pendingChanges: 0, pendingWrites: 0 });
    expect(result.isAnySyncing).toBe(false);
});
