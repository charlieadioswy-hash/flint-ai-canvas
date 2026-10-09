import { Input, InputNumber } from "antd";
import type { ModelProtocolParameter } from "@/lib/model-protocols";

export function ProviderParameterInput({ parameter, value, disabled, onChange = () => {} }: { parameter: ModelProtocolParameter; value?: unknown; disabled?: boolean; onChange?: (value: unknown) => void }) {
    if (parameter.type === "boolean" || parameter.values?.length) {
        const values = parameter.type === "boolean" ? ["true", "false"] : parameter.values || [];
        return (
            <select
                className="h-8 w-full rounded-md border border-border bg-background px-2"
                aria-label={parameter.name}
                disabled={disabled}
                value={value === undefined ? "" : String(value)}
                onChange={(event) => onChange(event.target.value === "" ? undefined : parameter.type === "boolean" ? event.target.value === "true" : event.target.value)}
            >
                <option value="">使用模型默认值</option>
                {values.map((item) => (
                    <option key={item} value={item}>
                        {item}
                    </option>
                ))}
            </select>
        );
    }
    if (parameter.type === "integer" || parameter.type === "number")
        return (
            <InputNumber
                className="!w-full"
                size="small"
                aria-label={parameter.name}
                disabled={disabled}
                value={typeof value === "number" ? value : null}
                precision={parameter.type === "integer" ? 0 : undefined}
                onChange={(next) => onChange(next === null ? undefined : Number(next))}
            />
        );
    return <Input size="small" aria-label={parameter.name} disabled={disabled} value={String(value ?? "")} placeholder={parameter.name} onChange={(event) => onChange(event.target.value)} />;
}
