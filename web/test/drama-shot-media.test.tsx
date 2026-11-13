import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("镜头独立媒体的确认、重放、版本与帧引用", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-shot-media.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("9 pass");
    expect(output).toContain("0 fail");
}, 25_000);
