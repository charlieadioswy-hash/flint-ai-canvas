import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("独立资产视图的配置、确认生成、引用继承、历史与会话保护", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-cast-views.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("8 pass");
    expect(output).toContain("0 fail");
}, 25_000);
