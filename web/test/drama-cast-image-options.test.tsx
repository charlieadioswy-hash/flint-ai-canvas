import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("单资产图片配置保存、参考组和迟到回执通过真实组件验证", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-cast-image-options.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 60000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("9 pass");
    expect(output).toContain("0 fail");
}, 60000);
