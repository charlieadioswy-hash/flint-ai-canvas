import { useEffect, useRef, useState } from "react";
import { Box, LoaderCircle } from "lucide-react";

import { getActiveUserScope } from "@/lib/user-scope";
import { modelThumbnailKey } from "@/lib/model-thumbnail";
import { getModelThumbnail } from "@/services/model-thumbnail";
import type { ModelAsset } from "@/stores/use-asset-store";

export function ModelAssetThumbnail({ asset, alt, className = "" }: { asset: ModelAsset; alt: string; className?: string }) {
    const target = useRef<HTMLSpanElement>(null);
    const scope = getActiveUserScope();
    const identity = modelThumbnailKey(asset.data, scope);
    const [visibleIdentity, setVisibleIdentity] = useState("");
    const [preview, setPreview] = useState<{ identity: string; url: string } | null>(null);
    const [failedIdentity, setFailedIdentity] = useState("");
    const displayed = preview?.identity === identity ? preview.url : "";
    const failed = failedIdentity === identity;
    const visible = visibleIdentity === identity;

    useEffect(() => {
        const element = target.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setVisibleIdentity(identity);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisibleIdentity(identity);
                    observer.disconnect();
                }
            },
            { rootMargin: "160px" },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, [identity]);

    const { storageKey, url, fileName, mimeType } = asset.data;
    useEffect(() => {
        if (!visible) return;
        const controller = new AbortController();
        let objectUrl = "";
        void getModelThumbnail({ storageKey, url, fileName, mimeType }, controller.signal)
            .then((blob) => {
                if (controller.signal.aborted || getActiveUserScope() !== scope) return;
                objectUrl = URL.createObjectURL(blob);
                setPreview({ identity, url: objectUrl });
                setFailedIdentity("");
            })
            .catch(() => {
                if (!controller.signal.aborted && getActiveUserScope() === scope) setFailedIdentity(identity);
            });
        return () => {
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [visible, identity, scope, storageKey, url, fileName, mimeType]);

    return (
        <span ref={target} className="relative block h-full w-full" aria-busy={visible && !displayed && !failed}>
            {displayed && !failed ? (
                <img src={displayed} alt={alt} className={className} decoding="async" onError={() => setFailedIdentity(identity)} />
            ) : (
                <span className="flex h-full w-full flex-col items-center justify-center gap-2 bg-foreground/[.04] text-foreground/45">
                    {visible && !failed ? <LoaderCircle className="size-7 motion-safe:animate-spin" aria-hidden="true" /> : <Box className="size-8" aria-hidden="true" />}
                    <span className="max-w-[76%] truncate text-[var(--fs-micro)]">{failed ? "缩略图暂不可用" : visible ? "正在生成缩略图…" : fileName}</span>
                </span>
            )}
        </span>
    );
}
