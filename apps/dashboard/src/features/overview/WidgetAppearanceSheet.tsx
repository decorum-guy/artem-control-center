import type { OverviewConfigValue, OverviewLayoutItem } from "@artem/contracts";
import { Sheet } from "../../Sheet";
import {
  appearanceControlLabel,
  appearanceControlSection,
  appearanceControlValueLabel,
  appearanceControlsForPresentation,
  type AppearanceControl
} from "./appearanceConfig";
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
  const controls = appearanceControlsForPresentation(item.widgetType);
  const config = item.config ?? {};
  const grouped = controls.reduce<Record<string, AppearanceControl[]>>((result, control) => {
    const section = appearanceControlSection(item.widgetType, control);
    (result[section] ??= []).push(control);
    return result;
  }, {});

  return (
    <Sheet
      title={definition ? `Настройки: ${definition.title}` : "Настройки виджета"}
      description="Изменения применяются только к текущему черновику до нажатия «Готово»."
      testId="overview-widget-appearance"
      onClose={onClose}
      footer={<button type="button" className="overview-appearance__reset" onClick={onReset}>Сбросить настройки</button>}
    >
      {!controls.length ? (
        <p className="overview-appearance__empty">Для этого виджета пока нет дополнительных настроек.</p>
      ) : Object.entries(grouped).map(([section, sectionControls]) => (
        <section className="overview-appearance__section" key={section}>
          <h3>{section}</h3>
          {sectionControls.map((control) => {
            const value = config[control.key] ?? control.defaultValue;
            const unavailable = controlDisabled(item, control);
            const label = appearanceControlLabel(control);
            const valueLabel = appearanceControlValueLabel(control, value);
            const controlId = `appearance-${item.instanceId}-${control.key}`;
            return (
              <div className={`overview-appearance__control${unavailable ? " overview-appearance__control--unavailable" : ""}`} key={control.key}>
                {control.control !== "boolean" && (
                  <div className="overview-appearance__control-heading">
                    <label htmlFor={controlId}>{label}</label>
                    <span>{unavailable ? "Недоступно для этого размера" : valueLabel}</span>
                  </div>
                )}
                {control.control === "integer_range" && (
                  <input
                    id={controlId}
                    className="overview-appearance__range"
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={value as number}
                    disabled={unavailable}
                    onChange={(event) => onChange(control.key, Number(event.target.value))}
                    aria-label={label}
                    aria-valuetext={valueLabel}
                  />
                )}
                {control.control === "boolean" && (
                  <label className="overview-appearance__switch-row" htmlFor={controlId}>
                    <span>{label}</span>
                    <span className="overview-appearance__switch-state" aria-hidden="true">{value ? "Вкл." : "Выкл."}</span>
                    <span className={`overview-appearance__switch${value ? " overview-appearance__switch--on" : ""}`} aria-hidden="true">
                      <input
                        id={controlId}
                        type="checkbox"
                        role="switch"
                        checked={Boolean(value)}
                        disabled={unavailable}
                        aria-label={label}
                        onChange={(event) => onChange(control.key, event.target.checked)}
                      />
                      <span className="overview-appearance__switch-track"><span /></span>
                    </span>
                  </label>
                )}
                {control.control === "enum" && (
                  <div className="overview-appearance__segmented" role="group" aria-label={label}>
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
