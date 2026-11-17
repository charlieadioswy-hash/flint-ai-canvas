import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("高级创建及旧草稿保存完整分集目录，章节预览不再筛选制作范围", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-create-catalog.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("3 pass");
    expect(output).toContain("0 fail");
}, 25_000);
