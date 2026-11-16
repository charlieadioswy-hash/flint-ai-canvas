import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("镜头独立媒体的自动报价、直接生成、重放与版本", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-shot-media.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 40_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toMatch(/\d+ pass/);
    expect(output).toContain("0 fail");
}, 45_000);
