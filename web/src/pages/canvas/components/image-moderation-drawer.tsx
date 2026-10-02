import { Alert, Button, Tag } from "antd";
import { LoaderCircle, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";

import { AppDrawer } from "@/components/ui/product/app-drawer";
import { imageModerationPresentation, imageModerationTone, isImageModerationPending } from "@/lib/canvas/image-moderation";
import type { ModerationReportSummary } from "@/services/api/image-moderation";

type Props = {
    open: boolean;
    imageTitle: string;
    report: ModerationReportSummary | null;
    stale?: boolean;
    busy?: boolean;
    submitting?: boolean;
    available?: boolean | null;
    error?: string;
    canCheck?: boolean;
    onClose: () => void;
    onRecheck?: () => void;
    onRefresh?: () => void;
};

export function ImageModerationDrawer({ open, imageTitle, report, stale = false, busy = false, submitting = false, available, error, canCheck = false, onClose, onRecheck, onRefresh }: Props) {
    const presentation = stale ? { label: "需要重新检测", tone: "warning" as const } : imageModerationPresentation(report);
    const pending = isImageModerationPending(report);
    const tone = imageModerationTone(presentation.tone);
    const time = report?.completedAt || report?.createdAt;
    return (
        <AppDrawer open={open} title="图片内容检测" onClose={onClose} size={420} styles={{ wrapper: { maxWidth: "100vw" } }}>
            <div data-canvas-no-zoom className="space-y-5" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <p className="m-0 truncate text-sm text-muted-foreground" title={imageTitle}>{imageTitle}</p>
                <div role="status" aria-live="polite" className="rounded-[var(--r-lg)] border border-border bg-muted/30 p-4">
                    <div className="flex items-center gap-2 font-semibold" style={{ color: tone }}>
                        {busy || pending ? <LoaderCircle className="size-5 motion-safe:animate-spin" /> : presentation.tone === "success" ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
                        {busy ? submitting ? "正在提交检测" : "正在读取报告" : presentation.label}
                    </div>
                    <p className="mb-0 mt-3 text-sm leading-6 text-muted-foreground">
                        {busy ? submitting ? "正在准备原图并提交检测，请稍候。" : "正在读取最新检测状态，不会提交新的检测。" : stale || report?.isCurrent === false ? "图片内容或检测规则已更新，请重新检测以获取当前报告。" : pending ? "正在汇总检测结果。关闭面板后检测仍会继续。" : report?.summary || "手动检测当前图片，完成后将展示统一的内容风险报告。"}
                    </p>
                </div>
                {error ? <Alert type="warning" showIcon title={error} /> : null}
                {available === false && !error ? <Alert type="warning" showIcon title="图片检测服务未配置，请联系管理员。" /> : null}
                {report?.status === "partial" ? <Alert type="warning" showIcon title="部分检测未完成" description="已发现的风险仍需关注；当前报告不能作为完整的无风险结论。" /> : null}
                {report?.riskTags.length ? (
                    <div>
                        <p className="mb-2 text-sm font-medium">风险提示</p>
                        <div className="flex flex-wrap gap-2">{report.riskTags.map((tag) => <Tag key={`${tag.code}:${tag.level}`} color={tag.level === "high" ? "error" : "warning"} className="m-0 whitespace-normal">{tag.label}</Tag>)}</div>
                    </div>
                ) : null}
                {time ? <p className="text-xs text-muted-foreground">{pending ? "提交时间" : "检测时间"}：{formatReportTime(time)}</p> : null}
                <p className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">检测结果用于内容风险提示，不代表版权授权或商用认证。</p>
                {canCheck ? <div className="flex justify-end">
                    {pending ? <Button icon={<RefreshCw className="size-4" />} onClick={onRefresh} disabled={busy}>刷新状态</Button> : <Button type="primary" icon={<RefreshCw className="size-4" />} loading={busy} onClick={onRecheck}>{report || stale ? "重新检测" : "开始检测"}</Button>}
                </div> : <p className="text-sm text-muted-foreground">{onRecheck ? "请登录后检测图片内容。" : "分享画布仅展示已有报告。"}</p>}
            </div>
        </AppDrawer>
    );
}

function formatReportTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
