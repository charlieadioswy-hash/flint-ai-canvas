import { useLocation, useSearchParams } from "react-router";
import { WorkspacePage } from "@/components/layout/workspace-page";
import DramaCreatePage from "./create";
import { DramaWorkflowEntry } from "./workflow-entry";

/** 旧详细创建草稿继续在原表单编辑；新作品统一从正文导入开始。 */
export default function DramaWorkflowCreatePage() {
    const [search] = useSearchParams();
    const location = useLocation();
    const state = location.state as { file?: File; prefill?: unknown } | null;
    if (search.has("draft") || search.get("mode") === "advanced" || state?.prefill) return <DramaCreatePage />;
    return (
        <WorkspacePage className="drama-root drama-workflow-create">
            <DramaWorkflowEntry showSteps initialFile={state?.file} focusInput={search.get("paste") === "1"} />
        </WorkspacePage>
    );
}
