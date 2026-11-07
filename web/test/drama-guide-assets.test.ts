import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧资产列表区分角色与造型，保留生成目标和状态保护", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-guide-assets.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("5 pass");
    expect(output).toContain("0 fail");
}, 20_000);
