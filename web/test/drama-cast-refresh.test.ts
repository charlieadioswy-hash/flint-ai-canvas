import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("真实短剧资产 hook 随生成结果刷新", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-cast-refresh.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("1 pass");
    expect(output).toContain("0 fail");
}, 20_000);
