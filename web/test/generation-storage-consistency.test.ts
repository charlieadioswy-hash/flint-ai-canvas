import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Bun 1.3.9 跨文件运行 Worker 时可能在销毁与动态导入阶段崩溃，使用独立进程隔离。
test("生成结果持久化、恢复与清理在独立进程中通过全部用例", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/generation-storage-consistency.harness.ts"], { cwd: resolve(import.meta.dir, ".."), timeout: 60_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("15 pass");
    expect(output).toContain("0 fail");
}, 65_000);
