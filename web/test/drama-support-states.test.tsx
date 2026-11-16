import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧队列与版本区区分加载、空记录和读取失败", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-support-states.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 30000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("0 fail");
}, 30000);
