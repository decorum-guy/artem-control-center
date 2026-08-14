import { useMemo, useState, type ReactNode } from "react";
import type { OverviewLayoutItem } from "@artem/contracts";
import { Icon } from "../../icons";
import { Sheet } from "../../Sheet";
import { overviewWidgetRegistry, type OverviewWidgetCategory } from "./overviewRegistry";

const categories: readonly OverviewWidgetCategory[] = ["Управление", "Планирование", "Дом", "Состояние", "Контекст"];

function purposeCopy(widgetType: string): string {
  switch (widgetType) {
    case "home.coffee-machine": return "Состояние и управление кофемашиной";
    case "system.rog-g703-operational": return "Операционное состояние компьютера";
    case "planning.summary": return "Ближайшие дела на сегодня";
    case "home.quick-actions": return "Быстрый доступ к домашним устройствам";
    case "system.health-summary": return "Состояние сервисов и резервных копий";
    case "weather.alert": return "Погодное предупреждение";
    case "planning.calendar-agenda": return "Ближайшие события календаря";
    case "planning.task-list": return "Список задач";
    default: return "Виджет панели";
  }
}

export function WidgetPicker({
  items,
  onAdd,
  onClose
}: {
  items: readonly OverviewLayoutItem[];
  onAdd: (widgetType: string) => void;
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const availableDefinitions = overviewWidgetRegistry;
  const searchVisible = availableDefinitions.length > 12;
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
    return availableDefinitions.filter((definition) => {
      if (!normalizedQuery) return true;
      return `${definition.title} ${definition.fixtureCopy} ${definition.widgetType}`.toLocaleLowerCase("ru-RU").includes(normalizedQuery);
    });
  }, [availableDefinitions, query]);

  return (
    <Sheet title="Добавить виджет" description="Выберите доступный виджет для панели." testId="overview-widget-picker" onClose={onClose}>
      {searchVisible && (
        <label className="overview-picker__search">
          <span>Поиск виджетов</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название виджета" />
        </label>
      )}
      <div className="overview-picker__groups">
        {categories.map((category) => {
          const definitions = visibleItems.filter((definition) => definition.category === category);
          if (!definitions.length) return null;
          return (
            <section key={category} className="overview-picker__group" aria-labelledby={`overview-picker-${category}`}>
              <h3 id={`overview-picker-${category}`}>{category}</h3>
              {definitions.map((definition) => {
                const existing = items.find((item) => item.widgetType === definition.widgetType);
                const added = definition.singleton && Boolean(existing && existing.visibility !== "hidden");
                return (
                  <div className="overview-picker__row" key={definition.widgetType} data-widget-type={definition.widgetType}>
                    <span className="overview-picker__icon" aria-hidden="true"><Icon name={definition.iconKey} /></span>
                    <div className="overview-picker__copy">
                      <strong>{definition.title}</strong>
                      <span>{purposeCopy(definition.widgetType)}</span>
                    </div>
                    <button
                      type="button"
                      className="overview-picker__add"
                      disabled={added}
                      onClick={() => onAdd(definition.widgetType)}
                    >
                      {added ? "Уже добавлен" : "Добавить"}
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      {items.some((item) => item.visibility === "hidden") && (
        <p className="overview-picker__hint">Скрытые виджеты сохраняют свою instance identity и появятся здесь как доступные для восстановления.</p>
      )}
    </Sheet>
  );
}
