import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧主体资产页隔离过期回执", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-workflow-assets.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 35_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("10 pass");
    expect(output).toContain("0 fail");
}, 40_000);
