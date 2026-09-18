// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useOwnerWarningDwell, PLANNING_WARNING_DWELL_MS, PLANNING_WARNING_RECOVERY_DWELL_MS } from "./planningWarningDwell";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessProps = {
  candidate: string | null;
  onState: (state: string | null) => void;
};

function Harness({ candidate, onState }: HarnessProps) {
  const state = useOwnerWarningDwell(candidate);
  useEffect(() => onState(state), [onState, state]);
  return null;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useOwnerWarningDwell", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
  });

  async function mount(initialCandidate: string | null): Promise<{
    latest: () => string | null;
    rerender: (nextCandidate: string | null) => Promise<void>;
  }> {
    let state: string | null = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const render = async (candidate: string | null) => {
      await act(async () => {
        root?.render(<Harness candidate={candidate} onState={(next) => { state = next; }} />);
        await settle();
      });
    };
    await render(initialCandidate);
    return {
      latest: () => state,
      rerender: render
    };
  }

  test("candidate becomes non-null -> warning is NOT visible before PLANNING_WARNING_DWELL_MS", async () => {
    const harness = await mount("warn_1");
    expect(harness.latest()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_DWELL_MS - 1);
      await settle();
    });
    expect(harness.latest()).toBeNull();
  });

  test("after the complete initial dwell -> warning becomes visible", async () => {
    const harness = await mount("warn_1");
    expect(harness.latest()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_DWELL_MS);
      await settle();
    });
    expect(harness.latest()).toBe("warn_1");
  });

  test("candidate becomes null after being visible -> warning stays visible before PLANNING_WARNING_RECOVERY_DWELL_MS", async () => {
    const harness = await mount("warn_1");
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_DWELL_MS);
      await settle();
    });
    expect(harness.latest()).toBe("warn_1");

    await harness.rerender(null);
    expect(harness.latest()).toBe("warn_1");

    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_RECOVERY_DWELL_MS - 1);
      await settle();
    });
    expect(harness.latest()).toBe("warn_1");
  });

  test("after complete recovery dwell -> warning disappears", async () => {
    const harness = await mount("warn_1");
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_DWELL_MS);
      await settle();
    });
    expect(harness.latest()).toBe("warn_1");

    await harness.rerender(null);

    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_RECOVERY_DWELL_MS);
      await settle();
    });
    expect(harness.latest()).toBeNull();
  });

  test("candidate appears and disappears before initial dwell completes -> warning must never flash visible later", async () => {
    const harness = await mount("warn_1");

    await act(async () => {
      vi.advanceTimersByTime(100);
      await settle();
    });
    expect(harness.latest()).toBeNull();

    await harness.rerender(null);

    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_DWELL_MS);
      await settle();
    });
    expect(harness.latest()).toBeNull();
  });

  test("when a warning is already visible and candidate changes to another warning -> verify the CURRENT intended implementation behavior", async () => {
    const harness = await mount("warn_1");
    await act(async () => {
      vi.advanceTimersByTime(PLANNING_WARNING_DWELL_MS);
      await settle();
    });
    expect(harness.latest()).toBe("warn_1");

    await harness.rerender("warn_2");

    // The implementation switches immediately if a warning is already visible
    expect(harness.latest()).toBe("warn_2");
  });
});
