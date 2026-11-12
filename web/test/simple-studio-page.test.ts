import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实简易制作页支持分集合成导出、跨集编辑、引用、资产弹窗与队列定位", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/simple-studio-page.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("23 pass");
    expect(output).toContain("0 fail");
}, 25_000);
