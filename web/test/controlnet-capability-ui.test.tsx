import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelCapabilityEditor } from "../src/components/model-capability-editor";
import { CanvasControlNetPopover } from "../src/components/canvas/canvas-controlnet-popover";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { structureControlNodeMetadata } from "../src/lib/canvas/controlnet";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";
import { channelValidationError } from "../src/pages/settings/channel-settings-pane";
import { CanvasNodeType } from "../src/types/canvas";

test("the real capability editor exposes structural fields only behind protocol metadata", () => {
    const profile = { version: 1, image: defaultImageCapabilityConfig("liblib-image") };
    const allowed = renderToStaticMarkup(<ModelCapabilityEditor value={profile} capability="image" protocol="future-control-provider" supportsControlNet section="references" />);
    expect(allowed).toContain("允许提交独立控制图及 ControlNet 参数");
    expect(allowed).toContain("最大控制组数");
    expect(allowed).toContain("支持的预处理器");
    expect(allowed).toContain("控制模型标识");
    const denied = renderToStaticMarkup(<ModelCapabilityEditor value={profile} capability="image" protocol="uncontrolled-provider" section="references" />);
    expect(denied).toContain("当前调用协议未声明结构控制能力");
    expect(denied).toContain("disabled");
});

test("the dedicated image has a discoverable structural settings command", () => {
    const node = { id: "controlled", type: CanvasNodeType.Image, title: "结构控制生图", position: { x: 0, y: 0 }, width: 720, height: 405, metadata: structureControlNodeMetadata() };
    const markup = renderToStaticMarkup(<CanvasControlNetPopover node={node} config={defaultConfig} onChange={() => {}} />);
    expect(markup).toContain('aria-label="结构控制生图设置"');
    expect(markup).toContain("结构控制");
    expect(markup).toContain('aria-expanded="false"');
});

test("personal Liblib channel configuration requires both signing credentials", () => {
    const channel = createModelChannel({ id: "liblib", name: "Liblib", baseUrl: "https://openapi.liblibai.cloud", apiKey: "test-access-key", models: ["model"], modelCosts: [{ model: "model", capability: "image", protocol: "liblib-image", billingMode: "fixed_request", unitPriceMicrocredits: 1 }] });
    expect(channelValidationError(channel)).toContain("Secret Key");
    expect(channelValidationError({ ...channel, secretKey: "test-secret-key" })).toBe("");
    const inherited = { ...channel, interfaceType: "liblib-image", modelCosts: channel.modelCosts?.map((cost) => ({ ...cost, protocol: undefined })) };
    expect(channelValidationError(inherited)).toContain("Secret Key");
    expect(channelValidationError({ ...inherited, secretKey: "test-secret-key" })).toBe("");
});
