import { expect, test } from "bun:test";
import { resolve } from "node:path";

// 隔离 DOM 与模块替身，避免影响其他使用真实工作台 hooks 的测试。
test("异形屏入口在真实路由中保留当前创作并支持明确切换", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/screen-creation-navigation.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 60000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("0 fail");
}, 60000);
