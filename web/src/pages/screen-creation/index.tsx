import { ScreenCreationWorkspace } from "./screen-creation-workspace";
import { useScreenCreation } from "./use-screen-creation";
import { useParams } from "react-router";
import { useUserStore } from "@/stores/use-user-store";

export default function ScreenCreationPage() {
    const { canvasId } = useParams();
    const userId = useUserStore((state) => state.user?.id);
    return <ScreenCreationForm key={`${userId || "guest"}:${canvasId || "new"}`} />;
}

function ScreenCreationForm() {
    return <ScreenCreationWorkspace {...useScreenCreation()} />;
}
