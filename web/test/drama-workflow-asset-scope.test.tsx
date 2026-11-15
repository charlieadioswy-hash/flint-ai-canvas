import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("资产按集范围与批量选择使用真实引用并隔离账号", () => {
    const run = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-asset-scope.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 30000 });
    const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
    expect(run.exitCode, output).toBe(0);
    expect(output).toContain("12 pass");
    expect(output).toContain("0 fail");
}, 35000);
