import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("资产辅助生成的确认、原提交恢复、显式采用与账号隔离", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-cast-assistance.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 25_000);
