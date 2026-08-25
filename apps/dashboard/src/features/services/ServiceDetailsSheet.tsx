import type { ServiceSnapshot } from "@artem/contracts";
import { useAccess } from "../../AccessControls";
import { avalarActionTitles } from "../../avalarApi";
import { useAvalarActions } from "../../AvalarActions";
import { Icon } from "../../icons";
import { Sheet } from "../../Sheet";
import { StatusText } from "../../ShellPrimitives";
import { healthLabel, healthTone } from "../operations/routeDensity";

const sourceLabels: Record<ServiceSnapshot["source"], string> = {
  live: "Актуальный источник",
  cached: "Последние доступные данные",
  fixture: "Тестовый режим",
  stale: "Данные могут быть устаревшими",
  unavailable: "Источник недоступен"
};
export function ServiceDetailsSheet({
  service,
  onClose
}: {
  service: ServiceSnapshot;
  onClose: () => void;
}) {
  const { explainAvailability } = useAccess();
  const avalar = useAvalarActions();
  const fixedActions = avalar.actionsFor(service);

  return (
    <Sheet
      title={service.title}
      eyebrow="Сведения о сервисе"
      description="Состояние и доступные действия сервиса."
      onClose={onClose}
      testId="service-details-sheet"
    >
      <div className="service-details-sheet__status">
        <Icon name="services" />
        <StatusText label={healthLabel(service.health)} tone={healthTone(service.health)} />
      </div>

      <dl className="service-details-sheet__facts">
        <div><dt>Сводка</dt><dd>{service.summary}</dd></div>
        <div><dt>Источник</dt><dd>{sourceLabels[service.source]}</dd></div>
        <div><dt>Свежесть</dt><dd>{service.presentation?.freshnessLabel ?? "не указана"}</dd></div>
        {service.presentation?.environment && <div><dt>Среда</dt><dd>{service.presentation.environment}</dd></div>}
      </dl>

      <section className="service-details-sheet__section" aria-labelledby="service-details-actions-title">
        <h3 id="service-details-actions-title">Управление</h3>
        {fixedActions.length ? (
          <div className="service-details-sheet__actions">
            {fixedActions.map((actionId) => {
              const decision = avalar.availabilityFor(actionId);
              const allowed = Boolean(
                decision &&
                !avalar.pendingAction &&
                ["allowed", "elevation_required"].includes(decision.availability)
              );
              return (
                <button
                  key={actionId}
                  type="button"
                  disabled={!allowed}
                  title={decision ? explainAvailability(decision.availability) : "Исполнитель недоступен"}
                  onClick={() => void avalar.run(service, actionId)}
                >
                  {avalarActionTitles[actionId]}
                </button>
              );
            })}
          </div>
        ) : service.actions.length ? (
          <>
            <p>Зарегистрированные возможности:</p>
            <ul className="service-details-sheet__capabilities">
              {service.actions.map((action) => <li key={action.id}>{action.title}</li>)}
            </ul>
            <p className="service-details-sheet__muted">Исполнитель этой операции в панели не предусмотрен.</p>
          </>
        ) : (
          <p className="service-details-sheet__muted">Управление не предусмотрено.</p>
        )}
      </section>
    </Sheet>
  );
}
