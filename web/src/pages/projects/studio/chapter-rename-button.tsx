import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Input } from "antd";
import { Pencil } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { dramaKeys } from "@/lib/drama/drama-query-keys";
import { useDramaOperationScope } from "./use-drama-operation-scope";
import { updateDramaChapter, type DramaChapterRef } from "@/services/api/drama";

export function ChapterRenameButton({ projectId, chapter, expectedRevision, disabled }: { projectId: string; chapter: DramaChapterRef; expectedRevision?: number; disabled?: boolean }) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const operation = useDramaOperationScope(projectId);
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState(chapter.title);
    const trimmed = title.trim();
    const rename = useMutation({
        mutationFn: ({ ticket }: { ticket: ReturnType<typeof operation.capture> }) => {
            if (!operation.isCurrent(ticket)) throw new Error("账号或项目已切换");
            return updateDramaChapter(projectId, chapter.id, { title: trimmed, expectedRevision });
        },
        onSuccess: async (_, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: dramaKeys.summary(projectId), exact: true }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.chapters(projectId) }),
                queryClient.invalidateQueries({ queryKey: dramaKeys.episodes(projectId) }),
                queryClient.invalidateQueries({ queryKey: ["drama", projectId, "chapter", chapter.id] }),
            ]);
            if (!operation.isCurrent(ticket)) return;
            setOpen(false);
            message.success("章节名称已保存");
        },
        onError: (error, { ticket }) => {
            if (!operation.isCurrent(ticket)) return;
            message.error(error instanceof Error ? error.message : "修改章节名称失败");
        },
    });
    const canSave = Boolean(trimmed) && trimmed !== chapter.title && !rename.isPending && !disabled;
    const save = () => {
        if (canSave) rename.mutate({ ticket: operation.capture() });
    };

    return (
        <>
            <Button
                size="small"
                type="text"
                className="shrink-0"
                disabled={disabled}
                icon={<Pencil className="size-3.5" />}
                aria-label={`修改章节名称：${chapter.title}`}
                onClick={() => {
                    setTitle(chapter.title);
                    setOpen(true);
                }}
            >
                改名
            </Button>
            <AppModal
                open={open}
                title="修改章节名称"
                onCancel={() => {
                    if (!rename.isPending) setOpen(false);
                }}
                onOk={save}
                okText="保存名称"
                cancelText="取消"
                confirmLoading={rename.isPending}
                okButtonProps={{ disabled: !canSave }}
                cancelButtonProps={{ disabled: rename.isPending }}
                closable={!rename.isPending}
                centered
                width={440}
            >
                <Input aria-label="章节名称" autoFocus value={title} maxLength={200} showCount disabled={rename.isPending} onChange={(event) => setTitle(event.target.value)} onFocus={(event) => event.currentTarget.select()} onPressEnter={save} />
            </AppModal>
        </>
    );
}
