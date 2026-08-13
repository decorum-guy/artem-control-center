const root = document.getElementById("prototype-root");

const iconPaths = {
  overview: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  weather: '<path d="M8 17h9a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.8A3.4 3.4 0 0 0 8 17Z"/><path d="M12 2v2M4.9 4.9l1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
  services: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="7" cy="6" r="1"/><circle cx="17" cy="12" r="1"/><circle cx="9" cy="18" r="1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  tasks: '<path d="m4 7 2 2 4-4M4 14l2 2 4-4M13 7h7M13 14h7M4 21h16"/>',
  reminder: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  system: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  settings: '<path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  coffee: '<path d="M5 8h12v6a6 6 0 0 1-12 0V8Z"/><path d="M17 10h1a3 3 0 0 1 0 6h-2M4 21h15M8 3c0 1 1 1 1 2M13 3c0 1 1 1 1 2"/>',
  laptop: '<rect x="4" y="4" width="16" height="11" rx="2"/><path d="m2 19 2-4h16l2 4H2Z"/>',
  kettle: '<path d="M7 8h9l2 10H5L7 8Z"/><path d="M9 8V5h5v3M18 10h1a3 3 0 0 1 0 6M8 21h8"/>',
  light: '<path d="M9 18h6M10 22h4M8.5 14.5A7 7 0 1 1 15.5 14.5c-1 .7-1.5 1.5-1.5 2.5h-4c0-1-.5-1.8-1.5-2.5Z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
  alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m14 7 3 3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  grip: '<circle cx="8" cy="7" r="1"/><circle cx="16" cy="7" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="8" cy="17" r="1"/><circle cx="16" cy="17" r="1"/>',
  resize: '<path d="M8 16 16 8M12 16h4v-4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  shield: '<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a1.5 1.5 0 0 1 0-3h3a6 6 0 0 0 0-12h-3Z"/><circle cx="7" cy="10" r="1"/><circle cx="9" cy="6" r="1"/><circle cx="14" cy="6" r="1"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
  backup: '<path d="M4 8v11h16V8M8 4h8l2 4H6l2-4Z"/><path d="M9 13h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.7A3.3 3.3 0 0 0 7 18Z"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  motion: '<path d="M4 8h10M8 4l-4 4 4 4M20 16H10M16 12l4 4-4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M17.9 16A7 7 0 0 1 6 18l-2-6"/>'
};

function icon(name, className = "") {
  return `<svg class="cc-icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.overview}</svg>`;
}

const view = new URLSearchParams(window.location.search).get("view") || "overview-night";
const dayTheme = view === "overview-day" || view === "weather-clear-day";
const route = view.startsWith("weather") ? "weather" : view.startsWith("services") ? "services" : view === "settings" ? "settings" : view === "planning" ? "tasks" : "overview";

const navPrimary = [
  ["overview", "Обзор", "overview"],
  ["weather", "Погода", "weather"],
  ["home", "Дом", "home"],
  ["services", "Сервисы", "services"]
];
const navPlanning = [
  ["calendar", "Календарь", "calendar"],
  ["tasks", "Задачи", "tasks"],
  ["reminders", "Напоминания", "reminder"]
];

function navItem([id, label, iconName]) {
  return `<button class="cc-nav-item ${route === id ? "active" : ""}" type="button">${icon(iconName)}<span>${label}</span></button>`;
}

function shell(content) {
  return `
    <div class="cc-app ${dayTheme ? "theme-day" : "theme-night"}" data-view="${view}">
      <div class="cc-shell">
        <aside class="cc-rail">
          <div class="cc-brand">
            <div class="cc-brand-mark">ACC</div>
            <div class="cc-brand-copy"><strong>Artem</strong><span>Control Center</span></div>
          </div>
          <nav class="cc-nav" aria-label="Основные разделы">${navPrimary.map(navItem).join("")}</nav>
          <div class="cc-nav-group-label">ПЛАНИРОВАНИЕ</div>
          <nav class="cc-nav cc-nav-planning" aria-label="Планирование">${navPlanning.map(navItem).join("")}</nav>
          <nav class="cc-nav cc-nav-secondary" aria-label="Система">
            ${navItem(["system", "Система", "system"])}
            ${navItem(["settings", "Настройки", "settings"])}
          </nav>
        </aside>
        <main class="cc-workspace">
          <header class="cc-header">
            <div class="cc-time"><time>13:56</time><span>четверг, 13 августа</span></div>
            <div class="cc-header-actions">
              <button class="cc-header-control cc-header-weather" type="button"><strong>Москва · 22°</strong><span>${view === "weather-rain-night" ? "Дождь до 16:30" : "Преимущественно ясно"}</span></button>
              <button class="cc-header-control" type="button"><i class="cc-status-dot warning"></i><span>1 требует внимания</span></button>
              <button class="cc-header-control" type="button">${icon("shield")}<span>Дом</span></button>
              <button class="cc-icon-button" type="button" aria-label="Настройки">${icon("settings")}</button>
            </div>
          </header>
          ${content}
        </main>
      </div>
    </div>`;
}

function machineIllustration() {
  return `<div class="cc-machine" aria-label="Схематичная кофемашина"><i class="cc-machine-body"></i><i class="cc-machine-head"></i><i class="cc-machine-spout"></i><i class="cc-machine-cup"></i><i class="cc-machine-base"></i></div>`;
}

function pageToolbar(title, context, actions = "") {
  return `<div class="cc-page-toolbar"><div class="cc-page-title"><h1>${title}</h1>${context ? `<span>${context}</span>` : ""}</div><div class="cc-page-actions">${actions}</div></div>`;
}

function editHandles(size, canResize = true) {
  return `<button class="cc-edit-handle cc-drag-handle" type="button" aria-label="Переместить">${icon("grip")}</button><button class="cc-edit-handle cc-remove-handle" type="button" aria-label="Убрать">${icon("close")}</button>${canResize ? `<span class="cc-size-label">${size}</span><button class="cc-edit-handle cc-resize-handle" type="button" aria-label="Изменить размер">${icon("resize")}</button>` : ""}`;
}

function overviewZones(edit = false) {
  const handles = edit ? editHandles : () => "";
  return `
    <div class="cc-overview-grid ${edit ? "cc-edit-grid" : ""}">
      <section class="cc-zone cc-rog">
        ${handles("12 × 1", false)}
        <div class="cc-rog-main">${icon("laptop")}<span class="cc-rog-name">ASUS ROG G703GI</span><span class="cc-rog-separator">·</span><span class="cc-state success"><i class="cc-status-dot"></i>В сети</span></div>
        <span class="cc-meta">проверено только что</span>
        <button class="cc-button" type="button">Гибернация</button>
      </section>
      <section class="cc-zone cc-coffee">
        ${handles("7 × 4")}
        <div class="cc-coffee-copy">
          <header class="cc-zone-header"><div class="cc-zone-title">${icon("coffee")}<h2>Кофемашина</h2></div><span class="cc-state success"><i class="cc-status-dot"></i>Доступна</span></header>
          <div class="cc-coffee-status"><strong>Выключена</strong><span>Последнее изменение сегодня в 14:50</span></div>
          <div class="cc-coffee-action"><button class="cc-button primary" type="button">Включить</button><div class="cc-authority">Состояние и управление · Home Assistant</div></div>
        </div>
        <div class="cc-coffee-visual">${machineIllustration()}</div>
      </section>
      <section class="cc-zone cc-planning">
        ${handles("5 × 4")}
        <header class="cc-zone-header"><div class="cc-zone-title">${icon("calendar")}<h2>Планирование</h2></div><span class="cc-meta">актуально</span></header>
        <div class="cc-planning-rows">
          <div class="cc-planning-row">${icon("reminder")}<div class="cc-row-copy"><strong>Позвонить врачу</strong><span>Напоминание · ожидает выполнения</span></div><span class="cc-row-time">15:00</span></div>
          <div class="cc-planning-row">${icon("tasks")}<div class="cc-row-copy"><strong>Отправить договор</strong><span>Сегодня · высокий приоритет</span></div><span class="cc-row-time">17:30</span></div>
          <div class="cc-planning-row">${icon("calendar")}<div class="cc-row-copy"><strong>Встреча по проекту</strong><span>Локальный календарь</span></div><span class="cc-row-time">19:00</span></div>
        </div>
      </section>
      <section class="cc-zone cc-home">
        ${handles("7 × 2")}
        <header class="cc-zone-header"><div class="cc-zone-title">${icon("home")}<h2>Дом</h2></div><span class="cc-state success"><i class="cc-status-dot"></i>HA в сети</span></header>
        <div class="cc-home-actions">
          <div class="cc-home-action">${icon("kettle")}<div class="cc-row-copy"><strong>Чайник</strong><span>Выключен · доступен</span></div><button class="cc-button" type="button">Включить</button></div>
          <div class="cc-home-action">${icon("light")}<div class="cc-row-copy"><strong>Свет кабинета</strong><span>Включён</span></div><button class="cc-button" type="button">Выключить</button></div>
        </div>
      </section>
      <section class="cc-zone cc-health">
        ${handles("5 × 2")}
        <header class="cc-zone-header"><div class="cc-zone-title">${icon("heart")}<h2>Состояние систем</h2></div><span class="cc-meta">Подробнее</span></header>
        <div class="cc-health-main"><i class="cc-status-dot warning"></i><span>4 в норме · 1 требует внимания</span></div>
        <div class="cc-health-incident"><span>Multi-action Service · деградация</span><span>Копии · не настроены</span></div>
      </section>
    </div>`;
}

function widgetPicker() {
  return `<div class="cc-picker-backdrop"></div><aside class="cc-picker" aria-label="Добавить виджет">
    <header class="cc-picker-header"><div><div class="cc-meta">БЕЗОПАСНЫЙ РЕЕСТР</div><h2>Добавить виджет</h2></div><button class="cc-icon-button" type="button" aria-label="Закрыть">${icon("close")}</button></header>
    <div class="cc-picker-body">
      <div class="cc-picker-group">УПРАВЛЕНИЕ</div>
      <div class="cc-picker-row">${icon("laptop")}<div class="cc-row-copy"><strong>ASUS ROG G703GI</strong><span>Операционная строка · 12×1</span></div><button class="cc-button" disabled>Добавлен</button></div>
      <div class="cc-picker-row">${icon("coffee")}<div class="cc-row-copy"><strong>Кофемашина</strong><span>Состояние и действие · 4×3–8×5</span></div><button class="cc-button" disabled>Добавлен</button></div>
      <div class="cc-picker-group">КОНТЕКСТ</div>
      <div class="cc-picker-row">${icon("weather")}<div class="cc-row-copy"><strong>Предупреждение погоды</strong><span>Только значимые события · 4×1</span></div><button class="cc-button primary">Добавить</button></div>
      <div class="cc-picker-row">${icon("calendar")}<div class="cc-row-copy"><strong>Повестка календаря</strong><span>Read-only agenda · 4×3–8×5</span></div><button class="cc-button primary">Добавить</button></div>
    </div>
    <footer class="cc-picker-footer"><button class="cc-button">Закрыть</button></footer>
  </aside>`;
}

function overviewPage(edit = false) {
  const actions = edit
    ? `<div class="cc-edit-state">${icon("edit")}<span>Редактирование панели · есть изменения</span></div><button class="cc-button">Сбросить</button><button class="cc-button">Отмена</button><button class="cc-button primary">Готово</button>`
    : `<button class="cc-button compact">${icon("edit")}<span style="margin-left:8px">Настроить</span></button>`;
  return `<div class="cc-route">${edit ? `<div class="cc-page-toolbar cc-edit-toolbar"><div class="cc-page-actions"><button class="cc-button primary">${icon("plus")}<span style="margin-left:8px">Добавить виджет</span></button></div><div class="cc-page-actions">${actions}</div></div>` : pageToolbar("Обзор", "Сегодня, всё важное в первом экране", actions)}${overviewZones(edit)}</div>${edit ? widgetPicker() : ""}`;
}

function weatherGlyph(kind = "clear") {
  if (kind === "rain") return `<svg class="cc-icon cc-weather-glyph" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 20h14a5 5 0 0 0 0-10 8 8 0 0 0-15.4 2.4A4.3 4.3 0 0 0 9 20Z"/><path d="m10 24-2 4M17 24l-2 4M24 24l-2 4"/></svg>`;
  return `<svg class="cc-icon cc-weather-glyph" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="6"/><path d="M16 2v5M16 25v5M2 16h5M25 16h5M6 6l4 4M22 22l4 4M26 6l-4 4M10 22l-4 4"/></svg>`;
}

function weatherPage(rain = false) {
  const condition = rain ? "Дождь" : "Преимущественно ясно";
  const hours = ["Сейчас", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"];
  const temps = rain ? ["14°", "14°", "13°", "13°", "12°", "12°", "11°"] : ["22°", "22°", "22°", "21°", "21°", "20°", "19°"];
  return `<div class="cc-route cc-weather-route">
    <div class="cc-weather-toolbar"><button class="cc-header-control cc-location-button">${icon("weather")}<span>Москва</span>${icon("chevron")}</button><div class="cc-page-actions"><button class="cc-button">+ Место</button><button class="cc-button">Управление</button><button class="cc-icon-button" aria-label="Обновить">${icon("refresh")}</button></div></div>
    <section class="cc-zone cc-weather-hero ${rain ? "rain-night" : "clear-day"}">
      <div class="cc-weather-atmosphere">${rain ? `<div class="cc-cloud-static"></div><div class="cc-rain-plane"></div>` : `<div class="cc-sun"></div><div class="cc-clear-haze"></div>`}</div>
      <div class="cc-weather-top"><div><div class="cc-weather-location-label">СЕЙЧАС</div><div class="cc-weather-location">Москва</div></div><div class="cc-weather-fresh">Обновлено только что<br>Europe/Moscow</div></div>
      <div class="cc-weather-primary"><div class="cc-weather-temp">${rain ? "14°" : "22°"}</div><div class="cc-weather-condition">${condition}</div></div>
      <div class="cc-weather-metrics"><div class="cc-weather-metric"><span>Ощущается</span><strong>${rain ? "12°" : "21°"}</strong></div><div class="cc-weather-metric"><span>Осадки</span><strong>${rain ? "2,4 мм" : "0 мм"}</strong></div><div class="cc-weather-metric"><span>Ветер</span><strong>${rain ? "18 км/ч" : "7 км/ч"}</strong></div><div class="cc-weather-metric"><span>Сегодня</span><strong>${rain ? "15° / 9°" : "24° / 13°"}</strong></div></div>
    </section>
    <div class="cc-weather-lower"><section class="cc-zone cc-hourly"><header class="cc-zone-header"><div class="cc-zone-title"><h2>Ближайшие часы</h2></div><span class="cc-meta">24 часа →</span></header><div class="cc-hour-list">${hours.map((hour, index) => `<div class="cc-hour"><span>${hour}</span>${weatherGlyph(rain ? "rain" : "clear")}<strong>${temps[index]}</strong><span>${rain ? 80 - index * 5 : 12 + index * 3}%</span></div>`).join("")}</div></section><section class="cc-zone cc-weather-context"><header class="cc-zone-header"><div class="cc-zone-title"><h2>${rain ? "Условия" : "Световой день"}</h2></div></header><div class="cc-context-list"><div class="cc-context-row"><span>${rain ? "Дождь закончится" : "Восход"}</span><strong>${rain ? "16:30" : "05:03"}</strong></div><div class="cc-context-row"><span>${rain ? "Влажность" : "Закат"}</span><strong>${rain ? "84%" : "20:24"}</strong></div><div class="cc-context-row"><span>${rain ? "Видимость" : "УФ-индекс"}</span><strong>${rain ? "8 км" : "Умеренный"}</strong></div></div></section></div>
  </div>`;
}

function servicesPage() {
  return `<div class="cc-route">${pageToolbar("Сервисы", "Проблемы сначала; здоровые группы свёрнуты", `<button class="cc-button compact">${icon("filter")}<span style="margin-left:8px">Фильтр</span></button>`)}
    <section class="cc-zone cc-attention-summary">${icon("alert")}<div class="cc-attention-copy"><strong>1 сервис требует внимания</strong><span>Основные функции панели доступны. Ошибка изолирована в одном сервисе.</span></div><button class="cc-button">Обновить проверки</button></section>
    <section class="cc-zone cc-service-zone"><header class="cc-service-zone-header"><div class="cc-zone-title"><h2>Требует внимания</h2></div><span class="cc-meta">1 сервис</span></header>
      <div class="cc-service-row"><div class="cc-service-name"><strong>Multi-action Service</strong><span>Personal infrastructure · monitor/actions</span></div><div class="cc-service-facts"><span class="cc-state warning"><i class="cc-status-dot warning"></i>Деградация</span><span>ответ 1,8 с</span></div><button class="cc-button">Диагностика</button></div>
      <div class="cc-service-row"><div class="cc-service-name"><strong>Резервные копии</strong><span>Конфигурация панели</span></div><div class="cc-service-facts"><span class="cc-state offline"><i class="cc-status-dot offline"></i>Не настроены</span><span>нет успешной копии</span></div><button class="cc-button">Подробнее</button></div>
    </section>
    <div class="cc-healthy-groups"><section class="cc-zone cc-healthy-row">${icon("home")}<strong>Дом · 4 сервиса в норме</strong><span class="cc-state success"><i class="cc-status-dot"></i>Актуально</span>${icon("chevron")}</section><section class="cc-zone cc-healthy-row">${icon("server")}<strong>Система · 3 сервиса в норме</strong><span class="cc-state success"><i class="cc-status-dot"></i>Актуально</span>${icon("chevron")}</section><section class="cc-zone cc-healthy-row">${icon("services")}<strong>AVALAR · 2 сервиса в норме</strong><span class="cc-state success"><i class="cc-status-dot"></i>Актуально</span>${icon("chevron")}</section><section class="cc-zone cc-healthy-row">${icon("cloud")}<strong>Внешние · 2 источника</strong><span class="cc-meta">1 не настроен</span>${icon("chevron")}</section></div>
  </div>`;
}

function settingsRows(kind) {
  if (kind === "left") return `
    <div class="cc-setting-row">${icon("coffee")}<div><strong>Кофемашина</strong><span>Время разогрева · уведомления</span></div>${icon("chevron", "cc-setting-chevron")}</div>
    <div class="cc-setting-row">${icon("bell")}<div><strong>Уведомления</strong><span>Каналы и доступность доставки</span></div>${icon("chevron", "cc-setting-chevron")}</div>
    <div class="cc-setting-row">${icon("overview")}<div><strong>Панель «Обзор»</strong><span>Виджеты, расположение, сброс</span></div>${icon("chevron", "cc-setting-chevron")}</div>`;
  return `
    <div class="cc-setting-row">${icon("user")}<div><strong>Профиль доступа</strong><span>Дом · обычный доступ</span></div>${icon("chevron", "cc-setting-chevron")}</div>
    <div class="cc-setting-row">${icon("lock")}<div><strong>PIN и временный доступ</strong><span>Политика повышения прав</span></div>${icon("chevron", "cc-setting-chevron")}</div>
    <div class="cc-setting-row">${icon("server")}<div><strong>Runtime панели</strong><span>Работает · обновлено только что</span></div>${icon("chevron", "cc-setting-chevron")}</div>`;
}

function settingsPage() {
  return `<div class="cc-route">${pageToolbar("Настройки", "Только параметры панели; без production credentials")}
    <section class="cc-zone cc-appearance-zone"><div class="cc-settings-copy"><strong>Внешний вид</strong><span>Тема и уровень движения применяются ко всей панели.</span></div><div class="cc-segmented" aria-label="Тема"><button>День</button><button class="active">Ночь</button></div><button class="cc-header-control">${icon("motion")}<span>Полное движение</span>${icon("chevron")}</button></section>
    <div class="cc-settings-columns"><section class="cc-zone cc-settings-zone">${settingsRows("left")}</section><section class="cc-zone cc-settings-zone">${settingsRows("right")}</section></div>
    <div class="cc-planning-note" style="margin-top:12px">${icon("shield")}<span>Секреты, токены и пароли не вводятся и не хранятся в интерфейсе панели.</span></div>
  </div>`;
}

const taskRows = [
  ["Отправить договор на согласование", "Проект AVAVALAR · локальная задача", "Сегодня, 17:30", "Высокий"],
  ["Проверить результат резервной копии", "Система · локальная задача", "Сегодня", "Обычный"],
  ["Подготовить план встречи", "Личное · локальная задача", "Завтра, 10:00", "Обычный"],
  ["Сверить календарь на следующую неделю", "Планирование · источник не выбран", "Пт, 14 августа", "Низкий"],
  ["Обновить документацию проекта", "AVALAR · локальная задача", "18 августа", "Обычный"]
];

function planningPage() {
  return `<div class="cc-route">${pageToolbar("Задачи", "AliceTG_Bot SQLite · canonical Planning", `<button class="cc-button primary" disabled>${icon("plus")}<span style="margin-left:8px">Добавить</span></button>`)}
    <div class="cc-planning-toolbar"><div class="cc-tabs"><button class="cc-tab active">Сегодня</button><button class="cc-tab">Просрочено</button><button class="cc-tab">Предстоящие</button></div><div class="cc-page-actions"><button class="cc-header-control">${icon("filter")}<span>Все проекты</span>${icon("chevron")}</button><span class="cc-source-state"><i class="cc-status-dot"></i>Актуально · 13:56</span></div></div>
    <section class="cc-zone cc-task-zone"><header class="cc-task-zone-header"><div class="cc-zone-title"><h2>Сегодня</h2></div><span class="cc-meta">5 задач · режим чтения</span></header>${taskRows.map((task, index) => `<div class="cc-task-row"><i class="cc-priority" style="background:${index === 0 ? "var(--cc-warning)" : index === 3 ? "var(--cc-text-muted)" : "var(--cc-accent)"}"></i><div class="cc-task-main"><strong>${task[0]}</strong><span>${task[1]}</span></div><span class="cc-task-project">${task[3]} приоритет</span><span class="cc-task-date">${task[2]}</span><span class="cc-readonly-slot">${icon("chevron")}</span></div>`).join("")}</section>
    <div class="cc-planning-note">${icon("shield")}<span>B3: мониторинг. Место для будущих B4-действий зарезервировано, но мутации выключены.</span></div>
  </div>`;
}

let content;
switch (view) {
  case "overview-edit": content = overviewPage(true); break;
  case "weather-clear-day": content = weatherPage(false); break;
  case "weather-rain-night": content = weatherPage(true); break;
  case "services-degraded": content = servicesPage(); break;
  case "settings": content = settingsPage(); break;
  case "planning": content = planningPage(); break;
  case "overview-day":
  case "overview-night":
  default: content = overviewPage(false);
}

root.innerHTML = shell(content);
