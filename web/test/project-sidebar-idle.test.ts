import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧侧栏支持手动开关，并保留闲置收起、键盘和移动端交互", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/project-sidebar-idle.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("9 pass");
    expect(output).toContain("0 fail");
}, 20_000);
