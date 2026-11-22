import { Button } from "antd";
import { Gift, LogOut, Settings, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useWorkspaceLogout } from "@/hooks/use-workspace-logout";
import { useUserStore } from "@/stores/use-user-store";
import { UserAvatar } from "./user-avatar";
import { UserGroupAvatarRing, UserGroupBadge } from "./user-group-badge";
import "./workspace-account-card.css";

/** 同一账户卡片用于顶部和侧栏；余额与退出均复用真实服务。 */
export function WorkspaceAccountCard({ onNavigate }: { onWallet: () => void; onNavigate: () => void }) {
    const user = useUserStore((state) => state.user);
    const referralAvailable = useUserStore((state) => state.referralAvailable);
    const { handleLogout, loggingOut } = useWorkspaceLogout();
    const { t } = useTranslation();
    if (!user) return null;
    const name = user.displayName || user.username;
    const accountLabel = user.email || `@${user.username}`;
    return (
        <section className="workspace-account-card" aria-label={t("shell.account.region")}>
            <header className="workspace-account-card-identity">
                <UserGroupAvatarRing>
                    <UserAvatar user={user} className="workspace-account-card-avatar" />
                </UserGroupAvatarRing>
                <div className="workspace-account-card-copy">
                    <div className="workspace-account-card-name">
                        <strong title={name}>{name}</strong>
                        <UserGroupBadge />
                    </div>
                    <span className="workspace-account-card-meta" title={accountLabel}>
                        {accountLabel}
                    </span>
                </div>
            </header>
            <nav className="workspace-account-card-actions" aria-label={t("shell.account.actions")}>
                <Link to="/settings?section=profile" onClick={onNavigate}>
                    <Settings aria-hidden />
                    {t("shell.account.settings")}
                </Link>
                {referralAvailable ? (
                    <Link to="/referral" onClick={onNavigate}>
                        <Gift aria-hidden />
                        {t("shell.account.referral")}
                    </Link>
                ) : null}
                {user.role === "admin" ? (
                    <Link to="/admin" onClick={onNavigate}>
                        <ShieldCheck aria-hidden />
                        {t("shell.account.adminConsole")}
                    </Link>
                ) : null}
                <Button danger type="text" icon={<LogOut aria-hidden />} loading={loggingOut} onClick={() => void handleLogout()}>
                    {t("shell.account.logout")}
                </Button>
            </nav>
        </section>
    );
}
