import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons";

interface StateProps { title: string; detail?: string; kicker?: string; icon?: IconName; action?: ReactNode }

export function EmptyState({ title, detail, kicker, icon = "archive", action }: StateProps) {
  return <div className="cc-empty-state">
    <Icon name={icon} size={24} />{kicker && <small>{kicker}</small>}
    <strong>{title}</strong>{detail && <p>{detail}</p>}{action}
  </div>;
}

export function ErrorState({ icon = "warning", ...props }: StateProps) {
  return <div className="cc-error-state" role="status"><EmptyState {...props} icon={icon} /></div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`cc-skeleton ${className}`} />;
}

export function Emblem({ size = 40 }: { size?: number }) {
  return <svg className="cc-emblem" viewBox="0 0 64 64" aria-hidden="true" width={size} height={size}>
    <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" opacity=".22" />
    <circle cx="32" cy="32" r="24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="96 7 31 17" transform="rotate(-110 32 32)" />
    <path d="M12 39l6-15 6 15m-9-5h6m14-8a7 7 0 1 0 0 12m13-12a7 7 0 1 0 0 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function BootScreen({ label }: { label: string }) {
  return <div className="cc-boot" role="status">
    <div className="cc-boot-rail" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>
    <div className="cc-boot-header" aria-hidden="true"><Skeleton /></div>
    <div className="cc-boot-center"><Emblem size={96} /><p>{label}</p></div>
  </div>;
}
