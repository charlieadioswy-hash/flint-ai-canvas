import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { dramaStudioPath, isAdvancedDramaStudio } from "@/pages/projects/studio/studio-route";

test("默认简易，既有详细面板深链保留详细模式，显式模式优先", () => {
    expect(isAdvancedDramaStudio(new URLSearchParams())).toBe(false);
    for (const query of ["view=cast", "view=inbox", "view=settings", "tab=script", "tab=final", "mode=advanced"]) expect(isAdvancedDramaStudio(new URLSearchParams(query))).toBe(true);
    for (const query of ["segment=0&shot=shot-a", "view=production&tab=board", "mode=simple&view=cast&tab=final"]) expect(isAdvancedDramaStudio(new URLSearchParams(query))).toBe(false);
});

test("切换简易模式清理复杂面板参数，保留当前集段、镜头和筛选", () => {
    const input = new URLSearchParams("mode=advanced&view=cast&cast=cast-a&tab=script&segment=2&shot=shot-a&scope=all&status=failed");
    const simple = new URL(dramaStudioPath("project/id", "episode/id", input, "simple"), "http://localhost");
    expect(simple.pathname).toBe("/projects/project%2Fid/e/episode%2Fid");
    expect(simple.searchParams.get("mode")).toBe("simple");
    for (const key of ["view", "cast", "tab"]) expect(simple.searchParams.has(key)).toBe(false);
    for (const key of ["segment", "shot", "scope", "status"]) expect(simple.searchParams.get(key)).toBe(input.get(key));
    expect(input.get("view")).toBe("cast");
    const advanced = new URL(dramaStudioPath("project/id", "episode/id", simple.searchParams, "advanced"), "http://localhost");
    expect(advanced.searchParams.get("segment")).toBe("2");
    expect(advanced.searchParams.get("shot")).toBe("shot-a");
    expect(advanced.searchParams.get("mode")).toBe("advanced");
});

test("旧详细深链通过真实制作台标签与面板导航后仍保留详细模式", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-studio-navigation.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 20_000);
