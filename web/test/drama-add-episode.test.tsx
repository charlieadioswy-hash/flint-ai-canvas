import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("新建分集使用真实版本并保护草稿与迟到回执", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-add-episode.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 25_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("8 pass");
    expect(output).toContain("0 fail");
}, 30_000);
