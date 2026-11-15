import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, ListBox, ListBoxItem, Popover, Select, SelectValue } from "react-aria-components";

import type { DramaAssetMode, DramaAssetScheme } from "@/services/api/drama";

import { AssetSchemePreview } from "./asset-scheme-preview";

function CharacterTemplateOptions({ schemes }: { schemes: DramaAssetScheme[] }) {
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // StrictMode 重放可能取消库内首次滚动；每次挂载后让当前项进入同一列表的可见区域。
        const frame = requestAnimationFrame(() => {
            const list = listRef.current;
            const current = list?.querySelector<HTMLElement>("[data-focused]") || list?.querySelector<HTMLElement>('[aria-selected="true"]');
            current?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
        return () => cancelAnimationFrame(frame);
    }, []);
    return (
        <ListBox ref={listRef} className="drama-character-template-list" aria-label="角色绘图模板选项" layout="grid" orientation="vertical" items={schemes}>
            {(scheme) => (
                <ListBoxItem id={scheme.mode} textValue={scheme.name} className="drama-character-template-option">
                    <AssetSchemePreview mode={scheme.mode} />
                    <strong>{scheme.name}</strong>
                    <small>{scheme.ratio} · 单张参考图</small>
                    <Check className="drama-character-template-check size-3.5" aria-hidden="true" />
                </ListBoxItem>
            )}
        </ListBox>
    );
}

export function CharacterTemplatePicker({ value, schemes, disabled, onChange }: { value: DramaAssetMode; schemes: DramaAssetScheme[]; disabled?: boolean; onChange: (mode: DramaAssetMode) => void }) {
    const selected = schemes.find((scheme) => scheme.mode === value);
    const label = selected?.name || "自定义模板";
    return (
        <Select className="drama-character-template-select" aria-label="角色绘图模板" selectedKey={value} isDisabled={disabled || !schemes.length} onSelectionChange={(key) => key !== null && onChange(key as DramaAssetMode)}>
            <Button className="drama-character-template-trigger">
                <span className="drama-character-template-selected" title={label}>
                    <AssetSchemePreview mode={selected?.mode || "custom"} />
                    <SelectValue>{() => label}</SelectValue>
                </span>
                <ChevronDown className="size-3.5" aria-hidden="true" />
            </Button>
            <Popover className="drama-character-template-popup drama-root" placement="bottom start" offset={4} containerPadding={16} maxHeight={460}>
                <CharacterTemplateOptions schemes={schemes} />
            </Popover>
        </Select>
    );
}
