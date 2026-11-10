import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧引导审阅支持混合进度、部分读取失败、按集编辑和提示词状态筛选", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-guide-story.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("8 pass");
    expect(output).toContain("0 fail");
}, 20_000);
