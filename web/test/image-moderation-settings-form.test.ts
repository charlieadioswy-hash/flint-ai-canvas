import { describe, expect, test } from "bun:test";

import {
    isModerationAdminState,
    moderationProviderDraft,
    moderationProviderDraftChanged,
    moderationProviderInput,
    moderationProviderResponseMatches,
    moderationProviderStatus,
    validateModerationProviderDraft,
} from "../src/pages/admin/settings/image-moderation-settings-form";
import type { ModerationAdminState, ModerationProviderView } from "../src/services/api/image-moderation";

const provider: ModerationProviderView = {
    id: "provider-1",
    name: "检测平台",
    type: "aliyun",
    enabled: true,
    archived: false,
    configId: "config-2",
    version: 2,
    region: "cn-shanghai",
    services: ["aigcCheck"],
    timeoutSeconds: 30,
    maxCallsPerDay: 100,
    minIntervalSeconds: 10,
    accessKeyIdConfigured: true,
    accessKeySecretConfigured: true,
};
const state: ModerationAdminState = {
    providers: [provider],
    activeProviderId: provider.id,
    activeConfigId: "config-1",
    policyRevision: 1,
    providerTypes: [
        {
            type: "aliyun",
            label: "阿里云",
            services: [
                { code: "aigcCheck", label: "内容风险" },
                { code: "aigcInfringement", label: "疑似侵权" },
            ],
            regions: [{ value: "cn-shanghai", label: "上海" }],
        },
    ],
};

describe("image moderation provider settings (offline)", () => {
    test("keeps persisted credentials out of drafts and omits blank credentials from updates", () => {
        const draft = moderationProviderDraft(provider, state);
        expect(draft.accessKeyId).toBe("");
        expect(draft.accessKeySecret).toBe("");
        expect(moderationProviderInput(draft)).not.toHaveProperty("accessKeyId");
        expect(moderationProviderInput(draft)).not.toHaveProperty("accessKeySecret");
        expect(validateModerationProviderDraft(draft, provider, state)).toBe("");
    });

    test("requires a complete credential pair for new providers and replacements", () => {
        const draft = moderationProviderDraft(null, state);
        draft.name = "新平台";
        expect(validateModerationProviderDraft(draft, null, state)).toContain("AccessKey");
        draft.accessKeyId = "offline-key";
        expect(validateModerationProviderDraft(draft, null, state)).toContain("同时填写");
        draft.accessKeySecret = "offline-secret";
        expect(validateModerationProviderDraft(draft, null, state)).toBe("");
        expect(validateModerationProviderDraft({ ...moderationProviderDraft(provider, state), accessKeyId: "offline-new-key" }, provider, state)).toContain("同时填写");
    });

    test("rejects unsupported services and non-positive repeat intervals", () => {
        const draft = moderationProviderDraft(provider, state);
        expect(validateModerationProviderDraft({ ...draft, services: [] }, provider, state)).toContain("检测项目");
        expect(validateModerationProviderDraft({ ...draft, services: ["unknownService"] }, provider, state)).toContain("检测项目");
        expect(validateModerationProviderDraft({ ...draft, minIntervalSeconds: 0 }, provider, state)).toContain("1–3600");
        expect(validateModerationProviderDraft({ ...draft, maxCallsPerDay: 100001 }, provider, state)).toContain("1–100000");
    });

    test("marks only real configuration or credential changes as dirty", () => {
        const draft = moderationProviderDraft(provider, state);
        expect(moderationProviderDraftChanged(draft, provider, state)).toBe(false);
        expect(moderationProviderDraftChanged({ ...draft, name: ` ${draft.name} ` }, provider, state)).toBe(false);
        expect(moderationProviderDraftChanged({ ...draft, maxCallsPerDay: 200 }, provider, state)).toBe(true);
        expect(moderationProviderDraftChanged({ ...draft, accessKeySecret: "offline-secret" }, provider, state)).toBe(true);
    });

    test("a saved new version does not imply it is the effective configuration", () => {
        expect(moderationProviderStatus(provider, state)).toEqual({ label: "新版本未应用", tone: "warning" });
        expect(moderationProviderStatus(provider, { activeProviderId: provider.id, activeConfigId: provider.configId })).toEqual({ label: "当前生效", tone: "success" });
        expect(moderationProviderStatus(provider, { activeProviderId: "", activeConfigId: "" }).label).toBe("备用");
    });

    test("rejects save responses that reuse a version or differ from the submitted limits", () => {
        const input = moderationProviderInput(moderationProviderDraft(provider, state));
        const updated = { ...provider, configId: "config-3", version: 3 };
        expect(moderationProviderResponseMatches(updated, input, provider)).toBe(true);
        expect(moderationProviderResponseMatches(provider, input, provider)).toBe(false);
        expect(moderationProviderResponseMatches({ ...updated, maxCallsPerDay: 999 }, input, provider)).toBe(false);
    });

    test("accepts pinned old configuration versions while rejecting an orphaned active policy", () => {
        expect(isModerationAdminState(state)).toBe(true);
        expect(isModerationAdminState({ ...state, activeProviderId: "missing" })).toBe(false);
        expect(isModerationAdminState({ ...state, activeConfigId: "" })).toBe(false);
        expect(isModerationAdminState({ ...state, policyRevision: 1.5 })).toBe(false);
        expect(isModerationAdminState({ ...state, providers: [{ ...provider, archived: true }] })).toBe(false);
    });
});
