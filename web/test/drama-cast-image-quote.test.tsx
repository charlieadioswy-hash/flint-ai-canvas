import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("资产图片报价保持保存后的生成范围校验和新执行令牌", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-cast-image-quote.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 60000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
    expect(output).toContain("0 fail");
}, 60000);
