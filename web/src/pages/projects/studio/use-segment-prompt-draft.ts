import { useEffect, useRef, useState } from "react";

export function useSegmentPromptDraft(saved: string, generated: string, onSave: (override: string) => Promise<unknown>) {
    const [edited, setEdited] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const inFlight = useRef(false);
    const draft = edited ?? saved;
    const dirty = draft.trim() !== saved.trim();
    useEffect(() => {
        if (edited !== null && !dirty) setEdited(null);
    }, [edited, dirty]);

    const save = async (override: string) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setSaving(true);
        try {
            await onSave(override);
            // The refetch may normalize the text. Only discard the submitted draft.
            setEdited((current) => (current === edited ? null : current));
        } catch {
            // The caller reports the failure; keep the draft editable for retry.
        } finally {
            inFlight.current = false;
            setSaving(false);
        }
    };
    const commit = () => {
        if (!dirty || inFlight.current) return;
        const next = draft.trim();
        if (!next) setEdited(null);
        else void save(next === generated.trim() ? "" : next);
    };

    return { draft, dirty, saving, setEdited, commit, restore: () => void save("") };
}
