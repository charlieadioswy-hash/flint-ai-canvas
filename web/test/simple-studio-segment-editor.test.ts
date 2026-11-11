import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("简易制作台复用真实段编辑写入，并隔离集定位与生成确认", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/simple-studio-segment-editor.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 20_000);
