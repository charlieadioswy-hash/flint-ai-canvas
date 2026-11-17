import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧主体资产直接编辑，隔离过期回执并保留阶段限制与业务冲突", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-assets.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 70_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("44 pass");
    expect(output).toContain("0 fail");
}, 75_000);
