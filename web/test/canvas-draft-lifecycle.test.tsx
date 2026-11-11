import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("画布草稿刷新通过真实生命周期保留入口模式并隔离账号", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-draft-lifecycle.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 30000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("6 pass");
    expect(output).toContain("0 fail");
}, 30000);
