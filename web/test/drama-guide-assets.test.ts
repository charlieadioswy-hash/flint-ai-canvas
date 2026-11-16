import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧资产卡直接编辑并区分造型操作，保留生成目标和状态保护", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-guide-assets.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("13 pass");
    expect(output).toContain("0 fail");
}, 20_000);
