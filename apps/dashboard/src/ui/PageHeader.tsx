import type { HTMLAttributes, ReactNode } from "react";
import { v3VisualSkinEnabled } from "../visualShellConfig";

export type PageHeaderVariant = "default" | "compact";

export type PageHeaderProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  variant?: PageHeaderVariant;
};

interface ComposedHeader extends HTMLAttributes<HTMLElement> {
  composition: "header" | "div";
  children: ReactNode;
}

export function PageHeader(props: PageHeaderProps | ComposedHeader) {
  if ("composition" in props) {
    const { composition: Tag, ...element } = props;
    return <Tag {...element} data-page-header={v3VisualSkinEnabled ? "composed" : undefined} />;
  }
  return <StandardHeader {...props} />;
}

function StandardHeader({
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
      data-page-header={v3VisualSkinEnabled ? variant : undefined}
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
