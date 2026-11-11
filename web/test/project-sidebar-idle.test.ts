import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("短剧侧栏按路由隔离闲置收起，并保留悬停、键盘和移动端交互", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/project-sidebar-idle.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 20_000);
