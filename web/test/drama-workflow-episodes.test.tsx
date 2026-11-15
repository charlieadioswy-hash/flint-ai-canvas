import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("分集管理批次范围、逐集合成版本和迟到回执通过真实组件验证", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-episodes.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 30_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("4 pass");
    expect(output).toContain("0 fail");
}, 35_000);
