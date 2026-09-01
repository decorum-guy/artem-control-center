import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./icons";

export type StatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "stale"
  | "offline"
  | "unavailable"
  | "uncertain";

export function StatusText({
  label,
  tone = "neutral",
  showIndicator = true,
  className
}: {
  label: string;
  tone?: StatusTone;
  showIndicator?: boolean;
  className?: string;
}) {
  return (
    <span className={[
      "v2-status-text",
      `v2-status-text--${tone}`,
      className
    ].filter(Boolean).join(" ")} data-state={tone}>
      {showIndicator && <span className="v2-status-text__indicator" aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}

export type RouteHeaderVariant = "default" | "compact";

export type RouteHeaderProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  variant?: RouteHeaderVariant;
};

export function RouteHeader({
  eyebrow,
  title,
  description,
  actions,
  variant = "default",
  className,
  ...props
}: RouteHeaderProps) {
  const compact = variant === "compact";
  return (
    <header
      {...props}
      className={[
        compact ? "density-route-toolbar" : "page-heading",
        "v2-route-header",
        className
      ].filter(Boolean).join(" ")}
      data-route-header-variant={variant}
    >
      {eyebrow && <p className="section-kicker">{eyebrow}</p>}
      <h1>{title}</h1>
      {compact && description && <span>{description}</span>}
      {actions}
      {!compact && description && <p>{description}</p>}
    </header>
  );
}

export function WorkZone({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section {...props} className={["v2-work-zone", className].filter(Boolean).join(" ")}>
      {children}
    </section>
  );
}

export function IconStatus({
  icon,
  label,
  tone = "neutral"
}: {
  icon: "shield" | "system";
  label: string;
  tone?: StatusTone;
}) {
  return (
    <span className="v2-icon-status">
      <Icon name={icon} />
      <StatusText label={label} tone={tone} showIndicator={false} />
    </span>
  );
}
