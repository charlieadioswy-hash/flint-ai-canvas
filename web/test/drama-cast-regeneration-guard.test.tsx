import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("资产重生成按真实视频确认并隔离账号、作品与迟到操作", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-cast-regeneration-guard.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 25_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("19 pass");
    expect(output).toContain("0 fail");
}, 30_000);
