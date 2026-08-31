import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanningDomainHealthStatus, PlanningSnapshot } from "@artem/contracts";
import { CalendarDisplayPreferencesProvider } from "./CalendarDisplayPreferences";
import { PlanningOverviewCard } from "./PlanningOverviewCard";
import { planningFixtures } from "./planningFixtures";

function withDomainStatus(snapshot: PlanningSnapshot, calendar: PlanningDomainHealthStatus): PlanningSnapshot {
  return {
    ...snapshot,
    sourceStatus: calendar === "current" || calendar === "retrying" ? "current" : calendar === "stale" ? "stale" : "degraded",
    health: {
      lastAttemptedAt: "2026-08-12T12:00:00Z",
      lastSuccessfulAt: "2026-08-12T11:59:00Z",
      consecutiveFailures: calendar === "current" ? 0 : 2,
      issues: [],
      domains: [
        { domain: "reminders", status: "current", consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
        { domain: "tasks", status: "current", consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
        { domain: "calendar", status: calendar, consecutiveFailures: calendar === "current" ? 0 : 2, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" },
        { domain: "projects", status: "current", consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" }
      ]
    }
  };
}

function overviewMarkup(planning: PlanningSnapshot, sizeVariant: "compact" | "standard" = "standard"): string {
  return renderToStaticMarkup(
    <CalendarDisplayPreferencesProvider>
      <PlanningOverviewCard planning={planning} sizeVariant={sizeVariant} onNavigate={() => undefined} />
    </CalendarDisplayPreferencesProvider>
  );
}

describe("Planning Overview domain composition", () => {
  it("collapses unavailable Calendar candidates once without crowding out healthy rows", () => {
    const event = planningFixtures.overviewDensity.calendar.upcoming[0];
    const snapshot = withDomainStatus({
      ...planningFixtures.overviewDensity,
      calendar: {
        ...planningFixtures.overviewDensity.calendar,
        upcoming: [
          { ...event, id: "calendar-a", title: "CAL_EVENT_A_159A4B", startAtUtc: "2026-08-12T12:50:00Z", endAtUtc: "2026-08-12T13:50:00Z" },
          { ...event, id: "calendar-b", title: "CAL_EVENT_B_159A4B", startAtUtc: "2026-08-12T13:00:00Z", endAtUtc: "2026-08-12T14:00:00Z" },
          { ...event, id: "calendar-c", title: "CAL_EVENT_C_159A4B", startAtUtc: "2026-08-12T13:10:00Z", endAtUtc: "2026-08-12T14:10:00Z" }
        ]
      }
    }, "unavailable");
    const markup = overviewMarkup(snapshot);

    expect(markup).toContain("planning-calendar-status-row");
    expect(markup.match(/Данные недоступны/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain("CAL_EVENT_A_159A4B");
    expect(markup).not.toContain("CAL_EVENT_B_159A4B");
    expect(markup).not.toContain("CAL_EVENT_C_159A4B");
    expect(markup).toContain("Позвонить в сервис");
    expect(markup).toContain("Ранняя задача");
    expect(markup).not.toContain("planning-overview-calendar-marker");
  });

  it("keeps stale and degraded retained Calendar events actionable and safely labelled", () => {
    const event = planningFixtures.overviewDensity.calendar.upcoming[0];
    for (const status of ["stale", "degraded"] as const) {
      const snapshot = withDomainStatus({
        ...planningFixtures.empty,
        calendar: {
          ...planningFixtures.empty.calendar,
          upcoming: [
            { ...event, id: `${status}-alpha`, title: `STALE_EVENT_ALPHA_159A4B_${status}`, calendarIdentity: { ...event.calendarIdentity!, providerId: "RAW_PROVIDER_ID_159A4B", providerLabel: "PRIVATE_CALDAV_URL_159A4B", calendarId: "OWNER_ACCOUNT_159A4B", calendarLabel: "Работа" } },
            { ...event, id: `${status}-beta`, title: `STALE_EVENT_BETA_159A4B_${status}`, calendarIdentity: { ...event.calendarIdentity!, calendarLabel: "Семья" } }
          ]
        }
      }, status);
      const markup = overviewMarkup(snapshot);
      expect(markup).toContain(`STALE_EVENT_ALPHA_159A4B_${status}`);
      expect(markup).toContain(`STALE_EVENT_BETA_159A4B_${status}`);
      expect(markup).toContain("Работа");
      expect(markup).toContain("Семья");
      expect(markup).toContain('data-planning-state="' + status + '"');
      expect(markup).not.toContain("PRIVATE_CALDAV_URL_159A4B");
      expect(markup).not.toContain("OWNER_ACCOUNT_159A4B");
      expect(markup).not.toContain("RAW_PROVIDER_ID_159A4B");
      expect(markup).toContain("planning-row--interactive");
    }
  });

  it("distinguishes stale empty Calendar from current confirmed empty Calendar", () => {
    const empty = { ...planningFixtures.empty, calendar: { ...planningFixtures.empty.calendar, today: [], upcoming: [] } };
    const staleMarkup = overviewMarkup(withDomainStatus(empty, "stale"));
    expect(staleMarkup).toContain("Данные могут быть устаревшими");
    expect(staleMarkup).not.toContain("Событий нет");
    expect(staleMarkup).not.toContain("Данные недоступны");

    const currentMarkup = overviewMarkup(withDomainStatus(empty, "current"));
    expect(currentMarkup).toContain("Событий нет");
  });
});
