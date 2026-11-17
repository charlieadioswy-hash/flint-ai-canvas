import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("我的作品固定十五部分页、响应式换行、筛选与删除末页恢复", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/drama-library-pagination.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("5 pass");
    expect(output).toContain("0 fail");
}, 25_000);
