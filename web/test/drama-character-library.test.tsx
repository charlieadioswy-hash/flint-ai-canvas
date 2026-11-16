import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("简易流程角色库导入、结构化信息及异步隔离", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-character-library.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 35_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("18 pass");
    expect(output).toContain("0 fail");
}, 40_000);
