import { useEffect, useRef, useState } from "react";
import { Button, Input } from "antd";
import { Sparkles } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { AppModal } from "@/components/ui/product/app-modal";
import { runBackendGenerationTask } from "@/services/api/generation-task";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export const model3DPromptExamples = [
    { title: "卡通机器人", prompt: "一个完整的卡通探索机器人，圆润头部，蓝色发光眼睛，短小四肢，橙白色金属外壳，清晰的机械接缝，左右对称，自然站立，单一独立物体，无底座、无背景、无文字。" },
    { title: "科幻跑车", prompt: "一辆完整的未来科幻跑车，低矮流线车身，宽体轮拱，四个独立车轮，银白色金属和蓝色发光饰条，车身结构闭合，硬表面细节清晰，单一独立物体，无场景、无文字。" },
    { title: "风格化道具", prompt: "一只风格化冒险游戏宝箱，圆弧木质箱盖，厚实金属包角和中央锁扣，木纹与磨损细节，结构完整，比例夸张而清晰，单一独立物体，无地面、无背景、无文字。" },
];

export function Model3DPromptIdeas({ prompt, onApply, onClose }: { prompt: string; onApply: (prompt: string) => void; onClose: () => void }) {
    const config = useEffectiveConfig();
    const userId = useUserStore((state) => state.user?.id);
    const isReady = useConfigStore((state) => state.isAiConfigReady);
    const [model, setModel] = useState(config.textModel);
    const [idea, setIdea] = useState(prompt);
    const [result, setResult] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const abort = useRef<AbortController | null>(null);
    useEffect(() => () => abort.current?.abort(), [userId]);
    const generate = async () => {
        if (busy || !idea.trim() || !model || !isReady(config, model)) return;
        const controller = new AbortController();
        abort.current = controller;
        setBusy(true);
        setError("");
        setResult("");
        try {
            const response = await runBackendGenerationTask({
                mode: "text",
                prompt: `将以下想法整理为一段可直接用于文本生成3D模型的中文提示词，只返回提示词，最多700字。写清单一主体的整体轮廓、结构、比例、材质、颜色和可建模细节，保证物体完整。不要添加摄影镜头、灯光场景、背景、文字或多个备选方案，不要包含Markdown。用户想法：\n${idea}`,
                config: { ...config, model, textModel: model },
                signal: controller.signal,
                streamText: false,
                metadata: { source: "model3d_prompt_ideas" },
            });
            if (controller.signal.aborted) return;
            const text = response.text?.trim();
            if (!text || Array.from(text).length > 1024) throw new Error("提示词为空或超过 1024 字，请调整想法后重试。");
            setResult(text);
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "提示词生成失败，请重试。");
        } finally {
            if (!controller.signal.aborted) setBusy(false);
        }
    };
    return (
        <AppModal open title="帮我想想 · 3D 模型描述" onCancel={onClose} footer={null} width={600}>
            <div className="model3d-ideas">
                <p className="model3d-hint">从示例开始，或选择文本模型，把一句想法扩展为模型描述。这里只准备提示词。</p>
                <div className="model3d-choices">
                    {model3DPromptExamples.map((example) => (
                        <Button key={example.title} disabled={busy} onClick={() => setResult(example.prompt)}>
                            {example.title}
                        </Button>
                    ))}
                </div>
                <Input.TextArea aria-label="3D 创意想法" value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="例如：一个适合游戏场景的圆润机器人" rows={3} maxLength={1024} disabled={busy} />
                <ModelPicker config={config} capability="text" value={model} onChange={setModel} placeholder="选择用于完善描述的文本模型" showOptionPrices />
                <Button icon={<Sparkles className="size-4" />} loading={busy} disabled={!idea.trim() || !model || !isReady(config, model)} onClick={() => void generate()}>
                    生成提示词
                </Button>
                {error ? (
                    <p role="alert" className="model3d-error">
                        {error}
                    </p>
                ) : null}
                {result ? (
                    <>
                        <Input.TextArea aria-label="生成的 3D 提示词" value={result} onChange={(event) => setResult(event.target.value)} rows={5} maxLength={1024} showCount />
                        <Button type="primary" disabled={!result.trim()} onClick={() => onApply(result.trim())}>
                            使用这段描述
                        </Button>
                    </>
                ) : null}
            </div>
        </AppModal>
    );
}
