import { useCallback, useLayoutEffect, useRef, useState } from "react";

type SeriesResult<R> = { accepted: number; completed: number; last: R | undefined; cancelled: boolean; error?: unknown };
interface Options<T, R> {
  mode: "ordered" | "latest" | "coalesced";
  coalesce?: (queue: T[], value: T) => T[];
  onProgress?: () => void;
  enabled: boolean;
  scope?: string;
  dispatch: (value: T, signal: AbortSignal) => Promise<R>;
  onFinish: (result: SeriesResult<R>) => void;
}
interface Series<T, R> {
  queue: T[];
  sent?: T;
  running: boolean;
  accepted: number;
  completed: number;
  last?: R;
  lastInput: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_VOLUME_STEPS = 12;
const QUIET_MS = 350;

/** One request in flight per control. Relative steps retain order, absolute targets can replace each other. */
export function useCommandSeries<T, R>(options: Options<T, R>) {
  const current = useRef<Series<T, R> | null>(null);
  const callbacks = useRef(options);
  const mounted = useRef(true);
  const [accepted, setAccepted] = useState(0);

  const finish = useCallback((series: Series<T, R>, error?: unknown) => {
    if (current.current !== series) return;
    current.current = null;
    clearTimeout(series.timer);
    if (!mounted.current) return;
    setAccepted(0);
    callbacks.current.onFinish({
      accepted: series.accepted, completed: series.completed, last: series.last,
      cancelled: series.controller.signal.aborted, error
    });
  }, []);

  const cancel = useCallback(() => {
    const series = current.current;
    if (!series) return;
    series.queue.length = 0;
    series.controller.abort();
    clearTimeout(series.timer);
    if (!series.running) finish(series);
  }, [finish]);

  useLayoutEffect(() => {
    const previousScope = callbacks.current.scope;
    callbacks.current = options;
    if (!options.enabled || previousScope !== options.scope) cancel();
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);

  async function drain(series: Series<T, R>) {
    series.running = true;
    try {
      while (series.queue.length && !series.controller.signal.aborted) {
        const value = series.queue.shift()!;
        series.sent = value;
        series.last = await callbacks.current.dispatch(value, series.controller.signal);
        series.completed++;
        if (callbacks.current.mode === "coalesced") series.sent = undefined;
        if (mounted.current) callbacks.current.onProgress?.();
      }
    } catch (error) {
      finish(series, error);
      return;
    } finally {
      series.running = false;
    }
    const wait = QUIET_MS - (performance.now() - series.lastInput);
    if (series.controller.signal.aborted || wait <= 0) finish(series);
    else series.timer = setTimeout(() => finish(series), wait);
  }

  function submit(value: T) {
    if (!mounted.current || !callbacks.current.enabled) return false;
    const series = current.current ??= {
      queue: [], accepted: 0, completed: 0, running: false, lastInput: 0,
      controller: new AbortController()
    };
    if (series.controller.signal.aborted) return false;
    if (options.mode === "ordered" && series.accepted >= MAX_VOLUME_STEPS) return false;
    if (options.mode === "coalesced" && options.coalesce) {
      const pending = options.coalesce(series.queue, value);
      if (pending.length > MAX_VOLUME_STEPS) return false;
      series.queue = pending;
    }
    clearTimeout(series.timer);
    series.lastInput = performance.now();
    series.accepted++;
    if (options.mode === "latest") {
      series.queue.length = 0;
      if (!Object.is(value, series.sent)) series.queue.push(value);
    } else if (options.mode === "ordered") {
      series.queue.push(value);
    }
    setAccepted(series.accepted);
    if (!series.running) void drain(series);
    return true;
  }

  return { submit, active: accepted > 0, full: options.mode === "ordered" && accepted >= MAX_VOLUME_STEPS,
    isActive: () => current.current !== null,
    pending: () => {
      const series = current.current;
      return series ? [...(series.sent === undefined ? [] : [series.sent]), ...series.queue] : [];
    },
  };
}
