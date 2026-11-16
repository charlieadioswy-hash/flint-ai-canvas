import { afterEach, expect, test } from "bun:test";
import { getDramaEpisodeStyle, updateDramaEpisodeStyle, type DramaEpisodeStyle, type DramaSettings } from "@/services/api/drama";
import { apiClient } from "@/services/api/request";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
});

const settings = {
    styleName: "电影感",
    stylePrompt: "冷暖对比",
    aspectRatio: "9:16",
    language: "中文普通话",
    episodeSeconds: 90,
    models: { text: {}, image: {}, video: {} },
    assets: { mode: "closeup_turnaround", characterPrompt: "角色三视图", scenePrompt: "场景全景", characterRatio: "16:9" },
    storyboard: {},
    reviewMode: "every",
    mediaMode: "manual",
    concurrency: 1,
    referenceLimit: 0,
} as DramaSettings;
const view: DramaEpisodeStyle = { projectId: "project/1", episodeId: "episode/1", revision: 7, episodeRevision: 3, settings };

test("本集完整配置读取保留内容、编码目标与取消信号", async () => {
    const controller = new AbortController();
    apiClient.defaults.adapter = async (config) => {
        expect(config.url).toBe("/dramas/project%2F1/episodes/episode%2F1/style");
        expect(config.signal).toBe(controller.signal);
        return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: view } };
    };
    expect(await getDramaEpisodeStyle("project/1", "episode/1", controller.signal)).toEqual(view);
});

test("旧版和缺失完整配置的成功响应明确失败，不伪装成可编辑的本集设置", async () => {
    const responses: unknown[] = [
        { projectId: view.projectId, episodeId: view.episodeId, mode: "inherit", styleName: "旧画风", stylePrompt: "旧提示词", drawing: { assets: settings.assets, models: settings.models } },
        { ...view, settings: null },
        { ...view, settings: {} },
        { ...view, settings: [] },
        { ...view, settings: { ...settings, stylePrompt: undefined } },
        { ...view, settings: { ...settings, models: undefined } },
        { ...view, settings: { ...settings, models: { text: {}, image: {} } } },
        { ...view, settings: { ...settings, assets: {} } },
        { ...view, settings: { ...settings, storyboard: undefined } },
    ];
    for (const response of responses) {
        let calls = 0;
        apiClient.defaults.adapter = async (config) => {
            calls++;
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: response } };
        };
        await expect(getDramaEpisodeStyle("project/1", "episode/1")).rejects.toThrow("本集配置读取不完整，请更新服务后刷新页面。");
        expect(calls).toBe(1);
    }
});

test("保存必须收到完整本集配置回执，异常回执不当作成功也不自动重发", async () => {
    const input = { expectedRevision: 7, expectedEpisodeRevision: 3, settings };
    for (const response of [view, { ...view, settings: undefined }]) {
        let calls = 0;
        apiClient.defaults.adapter = async (config) => {
            calls++;
            expect(config.method).toBe("patch");
            expect(config.url).toBe("/dramas/project%2F1/episodes/episode%2F1/style");
            expect(JSON.parse(config.data)).toEqual(input);
            return { config, headers: {}, status: 200, statusText: "OK", data: { code: 0, data: response } };
        };
        if (response.settings) expect(await updateDramaEpisodeStyle("project/1", "episode/1", input)).toEqual(view);
        else await expect(updateDramaEpisodeStyle("project/1", "episode/1", input)).rejects.toThrow("本集配置读取不完整");
        expect(calls).toBe(1);
    }
});
