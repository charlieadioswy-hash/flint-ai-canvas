import { useUserStore } from "@/stores/use-user-store";
import { Model3DWorkspace } from "./model3d-workspace";
import { useModel3DWorkflow } from "./use-model3d-workflow";

function Model3DSession() {
    return <Model3DWorkspace {...useModel3DWorkflow()} />;
}

export default function Model3DPage() {
    const userId = useUserStore((state) => state.user?.id);
    return <Model3DSession key={userId || "signed-out"} />;
}
