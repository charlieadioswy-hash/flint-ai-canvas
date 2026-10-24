import { expect, test } from "bun:test";

for (const interruptedImport of [false, true])
    for (const pendingEdit of [false, true])
        test(`ZIP model registration retry finishes sync${interruptedImport ? " after interrupted asset binding" : ""}${pendingEdit ? " and preserves unsubmitted editor input" : ""}`, async () => {
            // Isolate the real stores and their permanent auto-sync subscriptions.
            const child = Bun.spawn([process.execPath, "run", "test/helpers/canvas-import-sync-retry.worker.ts", pendingEdit ? "edited" : "unchanged", interruptedImport ? "interrupted" : "complete"], {
                cwd: new URL("..", import.meta.url).pathname,
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            expect(exitCode, stderr).toBe(0);
            const result = JSON.parse(stdout);
            expect(result.initialRegistration).toEqual({ assetId: result.assetId, created: true, linkedToProject: false, syncPending: true });
            expect(result.importedAssetBoundBeforeRetry).toBe(!interruptedImport);
            expect(result.assetAttempts).toBe(4);
            // The repair projection captures editor input before its first canvas write.
            // A fully bound import captures that input after saving, then patches it.
            const expectedCanvasWrites = pendingEdit && !interruptedImport ? 2 : 1;
            expect(result.canvasWrites).toBe(expectedCanvasWrites);
            expect(result.remoteRevision).toBe(expectedCanvasWrites);
            expect(result.nodeCounts).toEqual({ editor: 2, local: 2, remote: 2 });
            expect(result.bindings).toEqual([result.assetId, result.assetId, result.assetId]);
            expect(result.resultBindings).toEqual(result.bindings);
            expect(result.titles).toEqual(Array(3).fill(pendingEdit ? "Edited during retry" : "Text"));
            expect(result.progress).toMatchObject({ phase: "done", localPhase: "saved", pendingChanges: 0, pendingWrites: 0 });
            expect(result.isAnySyncing).toBe(false);
        });
