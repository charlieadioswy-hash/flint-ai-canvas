import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实分镜组组件与编辑器保留头部命名、底色和只读边界", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-frame-controls.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(output).toContain("0 fail");
    expect(result.exitCode, output).toBe(0);
}, 20000);
