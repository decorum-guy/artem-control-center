import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { Icon } from "./icons";
import { useVisualViewport } from "./useVisualViewport";
import "./Sheet.css";

export interface OverlayFrameProps {
  title: string;
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  canClose?: () => boolean;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  testId?: string;
  className?: string;
}

type OverlayVariant = "sheet" | "dialog";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])"
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => {
      if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
}

let overlayLockCount = 0;
let previousDocumentOverflow: { body: string; html: string } | null = null;

function acquireDocumentLock(): () => void {
  const body = document.body;
  const html = document.documentElement;
  if (overlayLockCount === 0) {
    previousDocumentOverflow = { body: body.style.overflow, html: html.style.overflow };
    body.classList.add("cc-overlay-open");
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
  }
  overlayLockCount += 1;

  return () => {
    overlayLockCount = Math.max(0, overlayLockCount - 1);
    if (overlayLockCount !== 0) return;
    body.classList.remove("cc-overlay-open");
    html.style.overflow = previousDocumentOverflow?.html ?? "";
    body.style.overflow = previousDocumentOverflow?.body ?? "";
    previousDocumentOverflow = null;
  };
}

function useBackgroundInert(): void {
  useEffect(() => {
    const appNodes = Array.from(document.querySelectorAll<HTMLElement>(".app"));
    const previous = appNodes.map((app) => ({
      app,
      inert: app.hasAttribute("inert"),
      ariaHidden: app.getAttribute("aria-hidden")
    }));
    appNodes.forEach((app) => {
      app.setAttribute("inert", "");
      app.setAttribute("aria-hidden", "true");
    });

    return () => {
      previous.forEach(({ app, inert, ariaHidden }) => {
        if (!app.isConnected) return;
        if (inert) app.setAttribute("inert", "");
        else app.removeAttribute("inert");
        if (ariaHidden === null) app.removeAttribute("aria-hidden");
        else app.setAttribute("aria-hidden", ariaHidden);
      });
    };
  }, []);
}

function scrollFocusedElementIntoSafeBodyArea(surface: HTMLElement, body: HTMLElement): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !body.contains(active)) return;

  const activeRect = active.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const footer = surface.querySelector<HTMLElement>(".cc-overlay__footer");
  const footerHeight = footer?.getBoundingClientRect().height ?? 0;
  const safeTop = bodyRect.top + 12;
  const safeBottom = Math.min(bodyRect.bottom, surface.getBoundingClientRect().bottom - footerHeight - 12);
  if (activeRect.bottom > safeBottom) {
    body.scrollBy({ top: activeRect.bottom - safeBottom, behavior: "auto" });
  } else if (activeRect.top < safeTop) {
    body.scrollBy({ top: activeRect.top - safeTop, behavior: "auto" });
  }
}

function OverlayFrame({
  variant,
  title,
  eyebrow,
  description,
  children,
  footer,
  onClose,
  canClose = () => true,
  closeOnEscape = true,
  closeOnBackdrop = true,
  initialFocusRef,
  restoreFocusRef,
  testId,
  className
}: OverlayFrameProps & { variant: OverlayVariant }) {
  const viewport = useVisualViewport();
  const surfaceRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  const titleId = `${testId ?? "cc-overlay"}-${useId().replace(/:/g, "")}-title`;
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;

  useBackgroundInert();

  useEffect(() => {
    const lockDocument = acquireDocumentLock();
    openerRef.current = restoreFocusRef?.current ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    const surface = surfaceRef.current;

    const focusInitial = () => {
      const preferred = initialFocusRef?.current;
      const first = surface ? focusableElements(surface)[0] : null;
      (preferred ?? first ?? surface ?? closeRef.current)?.focus();
    };

    focusInitial();
    const frame = window.requestAnimationFrame(focusInitial);
    const onFocusIn = (event: FocusEvent) => {
      if (surface && event.target instanceof Node && !surface.contains(event.target)) {
        focusInitial();
      } else if (surface && bodyRef.current && event.target instanceof HTMLElement && bodyRef.current.contains(event.target)) {
        window.requestAnimationFrame(() => scrollFocusedElementIntoSafeBodyArea(surface, bodyRef.current!));
      }
    };
    document.addEventListener("focusin", onFocusIn);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocusIn);
      lockDocument();
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) {
        opener.focus();
        window.requestAnimationFrame(() => opener.focus());
      }
    };
  }, [initialFocusRef, restoreFocusRef]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const body = bodyRef.current;
    if (!surface || !body) return;
    const frame = window.requestAnimationFrame(() => scrollFocusedElementIntoSafeBodyArea(surface, body));
    return () => window.cancelAnimationFrame(frame);
  }, [viewport.visibleHeight, viewport.offsetTop, viewport.bottomInset]);

  const requestClose = useCallback(() => {
    if (canCloseRef.current()) onCloseRef.current();
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      if (!closeOnEscape) return;
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== "Tab" || !surfaceRef.current) return;
    const focusables = focusableElements(surfaceRef.current);
    if (!focusables.length) {
      event.preventDefault();
      surfaceRef.current.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const atBoundary = active === surfaceRef.current || !surfaceRef.current.contains(active);
    if (event.shiftKey && (active === first || atBoundary)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || atBoundary)) {
      event.preventDefault();
      first.focus();
    }
  }

  const titleDescriptionId = description ? `${titleId}-description` : undefined;
  const surface = (
    <div
      className={`cc-overlay-backdrop cc-overlay-backdrop--${variant}`}
      data-testid={testId ? `${testId}-backdrop` : undefined}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        // Keep the portal mounted through pointerup/click. Closing on pointerdown
        // lets the browser retarget the remainder of the same gesture to newly
        // exposed background content.
        if (closeOnBackdrop && event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={surfaceRef}
        className={`cc-overlay cc-${variant}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={titleDescriptionId}
        tabIndex={-1}
        data-testid={testId}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="cc-overlay__header">
          <div className="cc-overlay__heading">
            {eyebrow && <p className="cc-overlay__eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
            {description && <p id={titleDescriptionId}>{description}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="cc-overlay__close"
            aria-label="Закрыть"
            onClick={requestClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div ref={bodyRef} className="cc-overlay__body">{children}</div>
        {footer !== undefined && footer !== null && <footer className="cc-overlay__footer">{footer}</footer>}
      </section>
    </div>
  );

  return typeof document === "undefined" ? surface : createPortal(surface, document.body);
}

export function Sheet(props: OverlayFrameProps) {
  return <OverlayFrame {...props} variant="sheet" />;
}

export { OverlayFrame };
