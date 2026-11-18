import { expect, spyOn, test } from "bun:test";
import { CanceledError } from "axios";
import { getDramaShotMedia } from "@/services/api/drama-shot-media";
import { apiClient } from "@/services/api/request";

test("镜头媒体读取既能超时，也能响应调用方取消", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const timeout = spyOn(AbortSignal, "timeout");
    try {
        for (const source of ["deadline", "shared-deadline", "caller"] as const) {
            const deadline = new AbortController();
            const caller = source === "deadline" ? undefined : new AbortController();
            timeout.mockReturnValue(deadline.signal);
            apiClient.defaults.adapter = (config) =>
                new Promise((_, reject) => {
                    const signal = config.signal as AbortSignal;
                    signal.addEventListener("abort", () => reject(new CanceledError()), { once: true });
                    (source === "caller" ? caller! : deadline).abort();
                    expect(signal.aborted).toBe(true);
                });
            await expect(getDramaShotMedia("project-1", "shot-1", "image", caller?.signal)).rejects.toMatchObject({ name: "AbortError" });
        }
    } finally {
        timeout.mockRestore();
        apiClient.defaults.adapter = originalAdapter;
    }
});
