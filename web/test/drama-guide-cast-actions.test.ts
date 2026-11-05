import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧引导的资产新增与删除确认", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-guide-cast-actions.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("4 pass");
    expect(output).toContain("0 fail");
}, 20_000);
