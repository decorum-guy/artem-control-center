import type { DashboardSnapshot } from "@artem/contracts";
import { isRuntimeShutdownPending } from "./runtimeLifecycle";

type SnapshotHandler = (snapshot: DashboardSnapshot) => void;
type ErrorHandler = (message: string) => void;
type EventSourceFactory = (url: string) => EventSource;

const CALM_RECONCILIATION_MS = 45_000;
const FALLBACK_POLL_MS = 5_000;
const HIDDEN_RECONCILIATION_MS = 60_000;
const MAX_RECONNECT_MS = 30_000;

export class SnapshotCoordinator {
  private readonly onSnapshot: SnapshotHandler;
  private readonly onError: ErrorHandler;
  private readonly eventSourceFactory: EventSourceFactory;
  private scenario: string;
  private eventSource: EventSource | null = null;
  private pollTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1_000;
  private abortController: AbortController | null = null;
  private inFlight: Promise<boolean> | null = null;
  private queued = false;
  private stopped = true;
  private sseConnected = false;
  private revision = 0;

  constructor({
    scenario,
    onSnapshot,
    onError,
    eventSourceFactory = (url) => new EventSource(url)
  }: {
    scenario: string;
    onSnapshot: SnapshotHandler;
    onError: ErrorHandler;
    eventSourceFactory?: EventSourceFactory;
  }) {
    this.scenario = scenario;
    this.onSnapshot = onSnapshot;
    this.onError = onError;
    this.eventSourceFactory = eventSourceFactory;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.refresh();
    this.connectSse();
  }

  stop() {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.eventSource?.close();
    this.eventSource = null;
    this.abortController?.abort();
    this.abortController = null;
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  refresh(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.inFlight) {
      this.queued = true;
      return this.inFlight;
    }
    this.abortController = new AbortController();
    this.inFlight = this.fetchSnapshot(this.abortController.signal).finally(() => {
      this.inFlight = null;
      this.abortController = null;
      if (this.queued && !this.stopped) {
        this.queued = false;
        void this.refresh();
      }
      this.schedulePoll();
    });
    return this.inFlight;
  }

  private async fetchSnapshot(signal: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(
        `/api/v1/snapshot?scenario=${encodeURIComponent(this.scenario)}`,
        { signal, cache: "no-store" }
      );
      if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
      const next = (await response.json()) as DashboardSnapshot;
      this.revision = Math.max(this.revision, next.revision);
      this.onSnapshot(next);
      this.onError("");
      return true;
    } catch (reason) {
      if (signal.aborted || isRuntimeShutdownPending()) return false;
      this.onError(reason instanceof Error ? reason.message : "Snapshot unavailable");
      return false;
    }
  }

  private connectSse() {
    if (this.stopped || this.eventSource) return;
    const source = this.eventSourceFactory("/api/v1/events");
    this.eventSource = source;
    source.addEventListener("connected", () => {
      this.sseConnected = true;
      this.reconnectDelay = 1_000;
      void this.refresh();
    });
    source.addEventListener("snapshot", (event) => {
      const revision = eventRevision(event);
      if (revision !== null && revision <= this.revision) return;
      void this.refresh();
    });
    source.addEventListener("heartbeat", () => {
      this.sseConnected = true;
    });
    source.onerror = () => {
      this.sseConnected = false;
      source.close();
      if (this.eventSource === source) this.eventSource = null;
      this.scheduleReconnect();
      this.schedulePoll();
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSse();
    }, delay);
  }

  private schedulePoll() {
    if (this.stopped) return;
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    const delay = document.hidden
      ? HIDDEN_RECONCILIATION_MS
      : this.sseConnected
        ? CALM_RECONCILIATION_MS
        : FALLBACK_POLL_MS;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.refresh();
    }, delay);
  }

  private readonly onVisibilityChange = () => {
    if (!document.hidden) void this.refresh();
    else this.schedulePoll();
  };
}

function eventRevision(event: Event): number | null {
  if (!(event instanceof MessageEvent)) return null;
  try {
    const value = Number((JSON.parse(String(event.data)) as { revision?: unknown }).revision);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
