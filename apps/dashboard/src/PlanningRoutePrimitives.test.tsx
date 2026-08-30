import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanningReadError } from "./planningReadClient";
import { PlanningRouteHealth } from "./PlanningRoutePrimitives";

function healthMarkup(properties: Partial<Parameters<typeof PlanningRouteHealth>[0]> = {}): string {
  return renderToStaticMarkup(
    <PlanningRouteHealth
      sourceStatus="unavailable"
      lastSyncedAt={null}
      onRetry={() => undefined}
      {...properties}
    />
  );
}

describe("Planning route health read transitions", () => {
  it("keeps a pending target read silent even when its envelope fallback is unavailable", () => {
    const markup = healthMarkup({ loading: true });
    expect(markup).toBe("");
    expect(markup).not.toContain("Данные недоступны");
  });

  it("shows a truthful unavailable surface after an unseen target request fails", () => {
    const markup = healthMarkup({
      error: new PlanningReadError("Planning route is unavailable", "http", 503)
    });
    expect(markup).toContain("Данные недоступны");
    expect(markup).toContain("Повторить");
  });

  it("does not show an owner warning while confirmed target data refreshes", () => {
    const markup = healthMarkup({
      sourceStatus: "current",
      hasConfirmedContent: true,
      refreshing: true
    });
    expect(markup).toContain("Обновляем…");
    expect(markup).not.toContain("Данные недоступны");
    expect(markup).not.toContain("Есть проблемы");
  });

  it("keeps a cached target failure on the existing warning dwell path", () => {
    const markup = healthMarkup({
      sourceStatus: "current",
      hasConfirmedContent: true,
      error: new PlanningReadError("Planning route is unavailable", "http", 503)
    });
    expect(markup).toBe("");
  });
});
