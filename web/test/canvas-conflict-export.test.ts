import { expect, spyOn, test } from "bun:test";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { MediaPackage } from "@/lib/media-package";
import { readZip } from "@/lib/zip";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportFile } from "@/types/canvas-export";

test("conflict archive keeps versions in distinct directories without changing ordinary duplicate rejection", async () => {
    const first: CanvasProject = {
        id: "same-canvas",
        title: "first draft",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        previsScenes: [],
    };
    const second = { ...first, title: "later draft" };
    let archive: Blob | undefined;
    const finish = MediaPackage.prototype.finish;
    const collectSpy = spyOn(MediaPackage.prototype, "collect").mockImplementation(async function (this: MediaPackage, _keys, directory) {
        const path = `${directory}/image.png`;
        this.put(path, new Blob([directory]));
        return [{ storageKey: "local-image", path, mimeType: "image/png", bytes: directory.length }];
    });
    const finishSpy = spyOn(MediaPackage.prototype, "finish").mockImplementation(async function (this: MediaPackage, name, manifest) {
        archive = await finish.call(this, name, manifest);
        return archive;
    });
    try {
        await expect(exportCanvasProjects([first, second])).rejects.toThrow("不能重复导出");
        await exportCanvasProjects([first, second], "conflict drafts", { allowProjectVersions: true });
        const files = await readZip(archive!);
        const manifest = JSON.parse(await files.get("projects.json")!.text()) as CanvasExportFile;
        expect(manifest.projects.map((item) => item.project.id)).toEqual([first.id, second.id]);
        expect(manifest.projects.map((item) => item.project.title)).toEqual(["first draft", "later draft"]);
        const paths = manifest.projects.map((item) => item.files[0]!.path);
        expect(new Set(paths).size).toBe(2);
        for (const path of paths) expect(files.has(path)).toBe(true);
    } finally {
        collectSpy.mockRestore();
        finishSpy.mockRestore();
    }
});
