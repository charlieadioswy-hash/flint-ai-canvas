import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("场景分镜重拆使用实际来源、显式报价与采用并隔离迟到结果", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-scene-splits.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 30_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
    expect(output).toContain("0 fail");
}, 35_000);
