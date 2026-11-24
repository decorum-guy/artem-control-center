import { useEffect, useState } from "react";
import type { StationReminderList } from "@artem/contracts";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: DEFAULT_PLANNING_TIME_ZONE
});
const statusText: Record<StationReminderList["status"], string> = {
  loading: "Загружаем напоминания…",
  fresh: "Данные актуальны",
  partial: "Яндекс вернул неполный список",
  stale: "Нет свежих данных",
  auth_required: "Нужно восстановить вход в Яндекс"
};

export function AliceRemindersSection() {
  const [list, setList] = useState<StationReminderList | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function read() {
      try {
        const response = await fetch("/api/v1/station/reminders", {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not read Alice reminders");
        const result: StationReminderList | null = await response.json();
        if (!controller.signal.aborted) setList(result);
      } catch {
        if (!controller.signal.aborted) {
          setList((previous) => previous && { ...previous, status: "stale" });
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(read, 10_000);
      }
    }

    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  if (!list) return null;
  return (
    <section className="planning-card planning-alice-reminders" aria-labelledby="alice-reminders-title"
      data-testid="alice-reminders" data-status={list.status}>
      <h2 id="alice-reminders-title">Напоминания Алисы</h2>
      <p className="planning-route-note" role="status">
        {statusText[list.status]}
        {list.observedAt && <> · Проверено <time dateTime={list.observedAt}>{dateTime.format(new Date(list.observedAt))}</time></>}
      </p>
      {list.status === "fresh" && list.items.length === 0 && <p>Активных напоминаний Алисы нет.</p>}
      {list.items.length > 0 && (
        <ul className="planning-route-list">
          {list.items.map((item) => (
            <li key={item.id} className="planning-route-row reminder-route-row">
              <div className="planning-route-row__main">
                <span className="planning-route-row__eyebrow">
                  <time dateTime={item.dueAt}>{dateTime.format(new Date(item.dueAt))}</time> · МСК
                  {item.repeats && " · Повторяется"}
                </span>
                <strong>{item.title}</strong>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
