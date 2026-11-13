import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧入口、视图切换与画布 Agent 状态回归", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-routing.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("10 pass");
    expect(output).toContain("0 fail");
}, 25_000);
