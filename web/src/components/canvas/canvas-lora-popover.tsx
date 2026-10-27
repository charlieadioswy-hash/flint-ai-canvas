import { Popover } from "antd";
import { Layers } from "lucide-react";
import { useState } from "react";
import { LiblibLoraFields } from "@/components/liblib-lora-fields";
import { LIBLIB_LORA_PROTOCOL, liblibLoraContext } from "@/lib/canvas/liblib-lora";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function CanvasLoraPopover({ node, config, disabled, onChange, onOpenChange }: { node: CanvasNodeData; config: AiConfig; disabled?: boolean; onChange: (patch: Partial<CanvasNodeMetadata>) => void; onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    const { profile, protocol, defaults } = liblibLoraContext(config);
    const saved = node.metadata?.providerOptions?.[LIBLIB_LORA_PROTOCOL];
    const value = saved?.additionalNetwork !== undefined ? saved.additionalNetwork : protocol === LIBLIB_LORA_PROTOCOL ? defaults.additionalNetwork : undefined;
    if (protocol !== LIBLIB_LORA_PROTOCOL && value === undefined) return null;
    const count = Array.isArray(value) ? value.length : 0;
    return <Popover open={open} onOpenChange={(next) => { setOpen(next); onOpenChange?.(next); }} trigger="click" placement="topLeft" content={<div className="max-h-[70vh] w-80 max-w-[calc(100vw-48px)] overflow-y-auto p-1 text-foreground" data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}><LiblibLoraFields value={value} profile={profile} protocol={protocol} disabled={disabled} onChange={(additionalNetwork) => onChange({ providerOptions: { ...node.metadata?.providerOptions, [LIBLIB_LORA_PROTOCOL]: { ...saved, additionalNetwork } } })} /></div>}><button type="button" className="canvas-node-composer-settings-trigger" disabled={disabled} aria-expanded={open} aria-label="LoRA 风格设置"><Layers className="size-3" /><span>LoRA{count ? ` · ${count}` : ""}</span></button></Popover>;
}
