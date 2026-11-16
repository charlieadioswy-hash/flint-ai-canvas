import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("继续选章保留真实范围、版本及账号隔离", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-chapter-picker.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 25_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("11 pass");
    expect(output).toContain("0 fail");
}, 30_000);
