import type {
  DashboardSnapshot,
  ServiceGroup,
  ServiceSnapshot,
  WidgetManifest
} from "@artem/contracts";
import { ErrorBoundary } from "./ErrorBoundary";
import { resolveManifest, servicesByPriority } from "./registry";
import type { RoutePath } from "./Shell";
import {
  CoffeeWidget,
  HealthMark,
  HomeDeviceWidget,
  ServiceRow
} from "./widgets";
import { CoffeeSettingsPanel } from "./CoffeeSettings";
import { RuntimeControls } from "./RuntimeControls";

interface PageProps {
  snapshot: DashboardSnapshot;
  onNavigate: (path: RoutePath) => void;
  onCoffeeAction?: (service: ServiceSnapshot, actionId: string) => void;
  coffeeActionPending?: boolean;
}

function PageHeading({
  eyebrow,
  title,
  description
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="page-heading">
      <p className="section-kicker">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function findManifestService(
  services: ServiceSnapshot[],
  manifestId: string
): { service: ServiceSnapshot; manifest: WidgetManifest } | null {
  const service = services.find((candidate) => resolveManifest(candidate).id === manifestId);
  return service ? { service, manifest: resolveManifest(service) } : null;
}

export function OverviewPage({ snapshot, onNavigate, onCoffeeAction, coffeeActionPending }: PageProps) {
  const ordered = servicesByPriority(snapshot.services);
  const coffee = findManifestService(ordered, "home.coffee-machine");
  const homeAuthority = ordered.find(
    (service) => service.presentation?.role === "home-authority"
  );
  const quickDevices = ordered.filter(
    (service) => service.presentation?.overview === "quick-control"
  );
  const serviceCatalog = ordered.filter(
    (service) => service.presentation?.category !== "home-device"
  );
  const healthyServices = serviceCatalog.filter((service) => service.health === "healthy").length;
  const attentionServices = serviceCatalog.filter((service) => service.health !== "healthy");
  const backupServices = ordered.filter((service) => service.dataContract.startsWith("backup."));

  return (
    <div className="overview-page" data-testid="route-overview">
      <PageHeading
        eyebrow="Сегодня"
        title="Обзор"
        description="Дом, ближайшие дела и состояние сервисов — без лишней технической детализации."
      />

      <div className="overview-focus" data-testid="overview-primary-content">
        <section className="overview-coffee" aria-label="Кофемашина">
          {coffee ? (
            <ErrorBoundary title={coffee.service.title}>
              <CoffeeWidget
                service={coffee.service}
                generatedAt={snapshot.generatedAt}
                manifest={coffee.manifest}
                onAction={onCoffeeAction}
                actionPending={coffeeActionPending}
              />
            </ErrorBoundary>
          ) : (
            <div className="empty-state">Кофемашина пока не добавлена в registry.</div>
          )}
        </section>

        <aside className="today-column" aria-label="Ближайшее и важное">
          <section className="context-section">
            <header>
              <p className="section-kicker">Дальше</p>
              <button type="button" onClick={() => onNavigate("/calendar")}>Календарь</button>
            </header>
            <strong>События не подключены</strong>
            <p>После подключения календаря здесь появится ближайшая встреча.</p>
          </section>
          <section className="context-section">
            <header>
              <p className="section-kicker">Задачи</p>
              <button type="button" onClick={() => onNavigate("/tasks")}>Открыть</button>
            </header>
            <strong>Нет источника задач</strong>
            <p>Срочные задачи появятся только из подключённого контракта.</p>
          </section>
          <section className={`attention-section ${attentionServices.length ? "attention-section--active" : ""}`}>
            <p className="section-kicker">Требует внимания</p>
            {attentionServices.length ? (
              <ul>
                {attentionServices.slice(0, 2).map((service) => (
                  <li key={service.id}>
                    <HealthMark health={service.health} compact />
                    <span>{service.title}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <strong>Ничего срочного</strong>
            )}
          </section>
        </aside>
      </div>

      <div className="overview-support">
        <section className="support-section home-summary">
          <header className="section-heading">
            <div>
              <p className="section-kicker">Дом</p>
              <h2>Быстрый доступ</h2>
            </div>
            <button type="button" onClick={() => onNavigate("/home")}>Открыть дом</button>
          </header>
          <div className="home-system-line">
            <span>Домашняя система</span>
            {homeAuthority ? (
              <HealthMark health={homeAuthority.health} compact />
            ) : (
              <span className="muted">Нет данных</span>
            )}
          </div>
          <div className="quick-device-list">
            {quickDevices.length ? (
              quickDevices.map((service) => (
                <HomeDeviceWidget key={service.id} service={service} />
              ))
            ) : (
              <p className="muted">Быстрые устройства ещё не настроены.</p>
            )}
          </div>
        </section>

        <section className="support-section services-summary">
          <header className="section-heading">
            <div>
              <p className="section-kicker">Сервисы</p>
              <h2>{healthyServices} работают{attentionServices.length ? ` · ${attentionServices.length} требуют внимания` : ""}</h2>
            </div>
            <button type="button" onClick={() => onNavigate("/services")}>Каталог</button>
          </header>
          <p>
            {attentionServices.length
              ? attentionServices[0].summary
              : "Активных incidents нет."}
          </p>
        </section>

        <section className="support-section backup-summary">
          <header className="section-heading">
            <div>
              <p className="section-kicker">Резервные копии</p>
              <h2>{backupServices.length ? "Состояние получено" : "Источник не подключён"}</h2>
            </div>
            <button type="button" onClick={() => onNavigate("/backups")}>Подробнее</button>
          </header>
          <p>
            {backupServices.length
              ? backupServices[0].summary
              : "Возраст последнего критичного backup пока неизвестен."}
          </p>
        </section>
      </div>
    </div>
  );
}

export function HomePage({ snapshot, onCoffeeAction, coffeeActionPending }: PageProps) {
  const ordered = servicesByPriority(snapshot.services);
  const coffee = findManifestService(ordered, "home.coffee-machine");
  const homeDevices = ordered.filter(
    (service) =>
      service.presentation?.category === "home-device" &&
      resolveManifest(service).id !== "home.coffee-machine"
  );
  const homeAuthority = ordered.find(
    (service) => service.presentation?.role === "home-authority"
  );

  return (
    <div className="home-page" data-testid="route-home">
      <div className="page-heading-row">
        <PageHeading
          eyebrow="Устройства"
          title="Дом"
          description="Повседневные устройства и сцены. Внутренняя архитектура Home Assistant остаётся в фоне."
        />
        <div className="infrastructure-indicator">
          <span>Home Assistant</span>
          {homeAuthority ? <HealthMark health={homeAuthority.health} compact /> : <span>Нет данных</span>}
        </div>
      </div>

      <div className="home-layout">
        {coffee && (
          <ErrorBoundary title={coffee.service.title}>
            <CoffeeWidget
              service={coffee.service}
              generatedAt={snapshot.generatedAt}
              manifest={coffee.manifest}
              variant="home"
              onAction={onCoffeeAction}
              actionPending={coffeeActionPending}
            />
          </ErrorBoundary>
        )}
        <section className="device-section">
          <header className="section-heading">
            <div>
              <p className="section-kicker">Устройства</p>
              <h2>Быстрые команды</h2>
            </div>
          </header>
          <div className="device-grid">
            {homeDevices.map((service) => (
              <HomeDeviceWidget key={service.id} service={service} prominent />
            ))}
            <div className="future-device">
              <strong>Новые устройства</strong>
              <span>Появятся здесь после регистрации manifest.</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const groupOrder: ServiceGroup[] = [
  "AVALAR",
  "Home infrastructure",
  "Personal infrastructure",
  "System",
  "External services"
];

const groupLabels: Record<ServiceGroup, string> = {
  AVALAR: "AVALAR",
  "Home infrastructure": "Домашняя инфраструктура",
  "Personal infrastructure": "Личная инфраструктура",
  System: "Система",
  "External services": "Внешние сервисы"
};

export function ServicesPage({ snapshot }: PageProps) {
  const catalog = servicesByPriority(snapshot.services).filter(
    (service) => service.presentation?.category !== "home-device"
  );
  const grouped = new Map<ServiceGroup, ServiceSnapshot[]>();

  for (const service of catalog) {
    const group = service.presentation?.group ?? "System";
    const services = grouped.get(group) ?? [];
    services.push(service);
    grouped.set(group, services);
  }

  return (
    <div className="services-page" data-testid="route-services">
      <PageHeading
        eyebrow="Операционный каталог"
        title="Сервисы"
        description="Состояние, свежесть и доступные операции. Monitor-only сервисы являются полноценными участниками каталога."
      />
      <div className="service-summary-line">
        <span>{catalog.filter((service) => service.health === "healthy").length} работают</span>
        <span>{catalog.filter((service) => service.health !== "healthy").length} требуют внимания</span>
        <span>{catalog.length} всего</span>
      </div>

      <div className="service-groups">
        {groupOrder.map((group) => {
          const services = grouped.get(group);
          if (!services?.length) return null;
          return (
            <section className="service-group" key={group}>
              <header>
                <h2>{groupLabels[group]}</h2>
                <span>{services.length}</span>
              </header>
              <div className="service-list">
                {services.map((service) => (
                  <ErrorBoundary key={service.id} title={service.title}>
                    <ServiceRow service={service} />
                  </ErrorBoundary>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const placeholderCopy: Record<
  Exclude<RoutePath, "/overview" | "/home" | "/services" | "/settings" | "/dev/widget-gallery">,
  { eyebrow: string; title: string; description: string; status: string }
> = {
  "/calendar": {
    eyebrow: "Расписание",
    title: "Календарь",
    description: "Ближайшие события и свободное время будут собраны в одном спокойном представлении.",
    status: "Интеграция календаря ещё не подключена."
  },
  "/tasks": {
    eyebrow: "Фокус",
    title: "Задачи",
    description: "Срочные, ближайшие и ожидающие задачи без перегруженного project-management интерфейса.",
    status: "Источник задач ещё не подключён."
  },
  "/backups": {
    eyebrow: "Надёжность",
    title: "Резервные копии",
    description: "Свежесть критичных копий, активные операции и подтверждённые restore points.",
    status: "Backup contract подготовлен, но runtime data ещё не подключены."
  },
  "/apps": {
    eyebrow: "Быстрый запуск",
    title: "Приложения",
    description: "Избранные локальные и web-приложения с policy-controlled actions.",
    status: "Каталог приложений ещё не настроен."
  },
  "/system": {
    eyebrow: "Панель управления",
    title: "Система",
    description: "Состояние Panel Agent, registry reconciliation и локального runtime.",
    status: "Подробные системные данные появятся после read-only adapter integration."
  }
};

export function PlaceholderPage({
  route
}: {
  route: keyof typeof placeholderCopy;
}) {
  const copy = placeholderCopy[route];
  return (
    <div className="placeholder-page" data-testid={`route-${route.slice(1)}`}>
      <PageHeading {...copy} />
      <section className="placeholder-surface">
        <span className="placeholder-status">Подготовлено</span>
        <h2>{copy.status}</h2>
        <p>Раздел использует общую navigation shell и будет наполняться только подтверждёнными данными.</p>
      </section>
    </div>
  );
}

export function SettingsPage({
  theme,
  motion,
  onThemeChange,
  onMotionChange
}: {
  theme: "day" | "night";
  motion: "full" | "reduced" | "low-performance" | "battery-saving";
  onThemeChange: (theme: "day" | "night") => void;
  onMotionChange: (motion: "full" | "reduced" | "low-performance" | "battery-saving") => void;
}) {
  return (
    <div className="settings-page" data-testid="route-settings">
      <PageHeading
        eyebrow="Панель"
        title="Настройки"
        description="Внешний вид и поведение этого экрана. Production credentials здесь не хранятся."
      />
      <CoffeeSettingsPanel />
      <section className="settings-section">
        <div>
          <h2>Тема</h2>
          <p>День и ночь используют одну систему поверхностей и семантических цветов.</p>
        </div>
        <div className="segmented-control" role="group" aria-label="Тема">
          {(["day", "night"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => onThemeChange(value)}
            >
              {value === "day" ? "День" : "Ночь"}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Движение</h2>
          <p>Уменьшенное движение, низкая производительность и экономия батареи сохраняют информацию без декоративной анимации.</p>
        </div>
        <select value={motion} onChange={(event) => onMotionChange(event.target.value as typeof motion)}>
          <option value="full">Полное</option>
          <option value="reduced">Уменьшенное движение</option>
          <option value="low-performance">Низкая производительность</option>
          <option value="battery-saving">Экономия батареи</option>
        </select>
      </section>
      <RuntimeControls />
    </div>
  );
}
