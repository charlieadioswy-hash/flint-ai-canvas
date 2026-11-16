import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("镜头提示词保留自然正文并解析当前镜头引用", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-shot-prompt-references.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
}, 20_000);
