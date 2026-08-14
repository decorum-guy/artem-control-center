import type { OverviewConfigValue, OverviewLayoutItem } from "@artem/contracts";
import { Icon } from "../../icons";
import { Sheet } from "../../Sheet";
import { appearanceControlValueLabel, appearanceControlsFor, type AppearanceControl } from "./appearanceConfig";
import { getOverviewWidgetDefinition } from "./overviewRegistry";

function controlDisabled(item: OverviewLayoutItem, control: AppearanceControl): boolean {
  return item.widgetType === "home.coffee-machine" && item.sizeVariant === "compact" &&
    ["imageScalePct", "imageXStep", "imageYStep", "composition", "showImage"].includes(control.key);
}

export function WidgetAppearanceSheet({
  item,
  onChange,
  onReset,
  onClose
}: {
  item: OverviewLayoutItem;
  onChange: (key: string, value: OverviewConfigValue) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const definition = getOverviewWidgetDefinition(item.widgetType);
  const controls = appearanceControlsFor(item.widgetType);
  const config = item.config ?? {};
  const grouped = controls.reduce<Record<string, AppearanceControl[]>>((result, control) => {
    (result[control.section] ??= []).push(control);
    return result;
  }, {});

  return (
    <Sheet
      title="Настройки виджета"
      eyebrow={definition?.title}
      description="Изменения применяются только к текущему черновику до нажатия «Готово»."
      testId="overview-widget-appearance"
      onClose={onClose}
      footer={<button type="button" className="overview-appearance__reset" onClick={onReset}>Вернуть настройки виджета</button>}
    >
      <div className="overview-appearance__identity">
        <span className="overview-appearance__icon" aria-hidden="true"><Icon name={definition?.iconKey ?? "overview"} /></span>
        <div>
          <strong>{definition?.title ?? item.widgetType}</strong>
          <span>{item.placement.w} × {item.placement.h} · {item.sizeVariant}</span>
        </div>
      </div>
      {!controls.length ? (
        <p className="overview-appearance__empty">Для этого виджета пока нет дополнительных настроек.</p>
      ) : Object.entries(grouped).map(([section, sectionControls]) => (
        <section className="overview-appearance__section" key={section}>
          <h3>{section}</h3>
          {sectionControls.map((control) => {
            const value = config[control.key] ?? control.defaultValue;
            const unavailable = controlDisabled(item, control);
            return (
              <div className={`overview-appearance__control${unavailable ? " overview-appearance__control--unavailable" : ""}`} key={control.key}>
                <div className="overview-appearance__control-heading">
                  <label htmlFor={`appearance-${item.instanceId}-${control.key}`}>{control.label}</label>
                  <span>{unavailable ? "Недоступно для этого размера" : appearanceControlValueLabel(control, value)}</span>
                </div>
                {control.control === "integer_range" && (
                  <input
                    id={`appearance-${item.instanceId}-${control.key}`}
                    className="overview-appearance__range"
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={value as number}
                    disabled={unavailable}
                    onChange={(event) => onChange(control.key, Number(event.target.value))}
                    aria-label={control.label}
                  />
                )}
                {control.control === "boolean" && (
                  <button
                    id={`appearance-${item.instanceId}-${control.key}`}
                    type="button"
                    className={`overview-appearance__toggle${value ? " overview-appearance__toggle--on" : ""}`}
                    disabled={unavailable}
                    aria-pressed={Boolean(value)}
                    onClick={() => onChange(control.key, !value)}
                  >
                    {value ? "Показывается" : "Скрыто"}
                  </button>
                )}
                {control.control === "enum" && (
                  <div className="overview-appearance__segmented" role="group" aria-label={control.label}>
                    {control.values.map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        className={value === option.value ? "overview-appearance__segment overview-appearance__segment--selected" : "overview-appearance__segment"}
                        disabled={unavailable}
                        aria-pressed={value === option.value}
                        onClick={() => onChange(control.key, option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </Sheet>
  );
}
