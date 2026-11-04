import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧异步投送在画布和账号切换后停止写入", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-drama-session.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 30000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("3 pass");
    expect(output).toContain("0 fail");
}, 30000);
