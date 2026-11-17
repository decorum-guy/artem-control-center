import type { HTMLAttributes, ReactNode } from "react";

export type PageHeaderVariant = "default" | "compact";

export type PageHeaderProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  variant?: PageHeaderVariant;
};

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  variant = "default",
  className,
  ...props
}: PageHeaderProps) {
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
