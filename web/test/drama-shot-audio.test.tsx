import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("镜头独立音频的真实确认、试听采用、恢复与范围隔离", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-shot-audio.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 25_000);
