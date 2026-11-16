import { expect, test } from "bun:test";
import { resolve } from "node:path";

// 弹窗依赖 Ant Design 与 happy-dom。放进独立进程，避免 mock 和 DOM 全局污染同一轮的其他用例。
test("媒体按钮在独立 DOM 中覆盖自动报价、一键执行和过期回执", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-media-action.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 60000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
    expect(output).toContain("0 fail");
}, 60000);
