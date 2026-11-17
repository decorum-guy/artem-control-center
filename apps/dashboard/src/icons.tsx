import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "overview"
  | "weather"
  | "home"
  | "services"
  | "coffee"
  | "timer"
  | "calendar"
  | "tasks"
  | "reminder"
  | "system"
  | "settings"
  | "grip"
  | "shield"
  | "close"
  | "refresh"
  | "lock"
  | "lock-open"
  | "power"
  | "minus"
  | "plus"
  | "check"
  | "sleep"
  | "hibernate"
  | "economy"
  | "performance"
  | "menu" | "chevron-down" | "chevron-right" | "chevron-left"
  | "warning" | "info" | "signal" | "archive" | "apps" | "thermometer"
  | "volume" | "brightness" | "drop" | "bin" | "edit" | "backspace";

type IconProps = Omit<SVGProps<SVGSVGElement>, "aria-hidden" | "aria-label"> & {
  name: IconName;
  size?: number;
  label?: string;
};

const iconPaths: Record<IconName, ReactNode> = {
  menu: <path d="M3 6h18M3 12h13M3 18h18" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  "chevron-left": <path d="m15 5-7 7 7 7" />,
  warning: <><path d="m12 3 10 17H2L12 3Z" /><path d="M12 9v5m0 2v1" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  signal: <><path d="M3 16v4m5-8v8m5-12v12m5-16v16" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v11h14V9m-10 4h6" /></>,
  apps: <><rect x="3" y="3" width="7" height="7" rx="2" /><circle cx="17" cy="6.5" r="3.5" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  thermometer: <><path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0Zm2-7v10" /><path d="M16 6h3m-3 4h2" /></>,
  volume: <><path d="M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
  brightness: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2" /></>,
  drop: <path d="M12 2c0 0-7 8-7 13a7 7 0 0 0 14 0c0-5-7-13-7-13Z" />,
  bin: <><path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  edit: <path d="m4 16 12-12 4 4L8 20l-5 1 1-5Zm10-10 4 4" />,
  backspace: <><path d="M3 12 9 5h12v14H9L3 12Z" /><path d="m11 9 6 6m0-6-6 6" /></>,
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </>
  ),
  weather: (
    <>
      <path d="M8 17h9a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.8A3.4 3.4 0 0 0 8 17Z" />
      <path d="M12 2v2M4.9 4.9l1.4 1.4M19.1 4.9l-1.4 1.4" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </>
  ),
  services: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="7" cy="6" r="1" />
      <circle cx="17" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
    </>
  ),
  coffee: (
    <>
      <path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9Z" />
      <path d="M16 11h2a3 3 0 0 1 0 6h-2M8 5c0 1 1 1 1 2M12 5c0 1 1 1 1 2M5 21h13" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 1.5M9 2h6M12 5V2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </>
  ),
  tasks: (
    <>
      <path d="m4 7 2 2 4-4M4 14l2 2 4-4M4 21h16" />
      <path d="M13 7h7M13 14h7" />
    </>
  ),
  reminder: (
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  system: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14h-.2v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2" />
      <circle cx="14" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </>
  ),
  grip: (
    <>
      <circle cx="8" cy="6" r="1" />
      <circle cx="16" cy="6" r="1" />
      <circle cx="8" cy="12" r="1" />
      <circle cx="16" cy="12" r="1" />
      <circle cx="8" cy="18" r="1" />
      <circle cx="16" cy="18" r="1" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-5" />
    </>
  ),
  close: (
    <path d="m6 6 12 12M18 6 6 18" />
  ),
  refresh: (
    <path d="M20 11a8 8 0 0 0-14.8-3.9L4 9M4 9h5M4 9V4M4 13a8 8 0 0 0 14.8 3.9L20 15M20 15h-5M20 15v5" />
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  "lock-open": (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 7.2-2.4" />
    </>
  ),
  power: (
    <>
      <path d="M12 2v9" />
      <path d="M6.4 5.8a8 8 0 1 0 11.2 0" />
    </>
  ),
  minus: (
    <path d="M5 12h14" />
  ),
  plus: (
    <path d="M5 12h14M12 5v14" />
  ),
  check: (
    <path d="m5 12 4.2 4.2L19 6.5" />
  ),
  sleep: (
    <>
      <path d="M19 15.5A8 8 0 0 1 8.5 5 8 8 0 1 0 19 15.5Z" />
      <path d="M17 5h3M18.5 3.5v3" />
    </>
  ),
  hibernate: (
    <>
      <path d="M6 5v14M18 5v14M6 12h12" />
      <path d="m9 8 3-3 3 3M9 16l3 3 3-3" />
    </>
  ),
  economy: (
    <>
      <path d="M12 21V10" />
      <path d="M12 14C7 14 5 10.5 5 6c5 0 7 3.5 7 8Z" />
      <path d="M12 17c4.5 0 7-2.5 7-7-4.5 0-7 2.5-7 7Z" />
    </>
  ),
  performance: (
    <path d="m13 2-8 12h6l-1 8 9-13h-6V2Z" />
  )
};

export function Icon({ name, size = 20, label, className, ...props }: IconProps) {
  return (
    <svg
      {...props}
      className={className}
      data-cc-icon=""
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  );
}
