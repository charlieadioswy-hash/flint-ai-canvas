import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("角色绘图模板与单张参考图构图、画幅和默认选择保持一致", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/asset-scheme-picker.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("5 pass");
    expect(output).toContain("0 fail");
}, 20_000);
