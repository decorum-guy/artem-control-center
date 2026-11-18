import { JarvisOrb, type OrbState } from "./JarvisOrb";
import { useState } from "react";
import { Icon } from "../icons";
import { Button, Segmented, Select, Slider, StatusChip, Stepper, Switch, type Tone } from "./Controls";
import { PageHeader } from "./PageHeader";
import { RingGauge, type RingReading } from "./RingGauge";
import { BootScreen, EmptyState, ErrorState, Skeleton } from "./States";

const orbStates: [OrbState, string][] = [
  ["idle","Ожидает"], ["listening","Слушает"], ["transcribing","Распознаёт"], ["submitting","Отправляет"],
  ["processing","Обрабатывает"], ["speaking","Говорит"], ["ready","Готово"], ["error","Ошибка"]
];
const themes = [{ value: "night", label: "Ночь" }, { value: "day", label: "День" }];
const sourceOptions = [{ value: "auto", label: "Автоматически" }, { value: "quiet", label: "Тихий" }, { value: "manual", label: "Ручной" }];
const statusLabels: [Tone, string][] = [
  ["neutral", "Ожидание"], ["accent", "Работает"], ["success", "Готово"], ["heat", "Нагрев"],
  ["warning", "Требует внимания"], ["danger", "Ошибка"], ["stale", "Устарело"], ["offline", "Нет связи"],
  ["unavailable", "Недоступно"], ["uncertain", "Уточняется"]
];
const readings: [RingReading, string][] = [
  [{ kind: "progress", fraction: .64 }, "64 %"],
  [{ kind: "stages", count: 4, active: 1 }, "Стадия 2 из 4"],
  [{ kind: "stale" }, "Устарело"], [{ kind: "unavailable" }, "Недоступно"],
  [{ kind: "running_too_long" }, "Дольше обычного"], [{ kind: "idle" }, "Ожидание"]
];

export default function SkinGallery({ jarvisEnabled }: { jarvisEnabled: boolean }) {
  const [mode, setMode] = useState("auto");
  const [theme, setTheme] = useState("night");
  const [on, setOn] = useState(true);
  const [volume, setVolume] = useState(32);
  const [temperature, setTemperature] = useState(24);
  const [boot, setBoot] = useState(false);
  return <section className="cc-gallery" data-testid="v3-primitive-gallery">
    <PageHeader eyebrow="Компоненты" title="Кабина" />
    <div className="cc-gallery-grid">
      <section><h2>Действия</h2><div className="cc-gallery-row">
        <Button variant="primary" icon="power">Включить</Button><Button>Параметры</Button>
        <Button variant="ghost" icon="info">Подробнее</Button><Button variant="danger" icon="bin">Удалить</Button>
        <Button disabled>Недоступно</Button><Button size={56} pendingLabel="Проверяем состояние…" />
      </div></section>
      <section><h2>Статус</h2><div className="cc-gallery-row">{statusLabels.map(([tone, label]) =>
        <StatusChip key={tone} tone={tone} label={label} icon={tone === "danger" || tone === "warning" ? "warning" : "signal"} running={tone === "accent"} />)}</div></section>
      <section><h2>Управление</h2><Select label="Режим" value={mode} options={sourceOptions} onChange={setMode} />
        <Segmented label="Вариант темы" value={theme} options={themes} onChange={setTheme} />
        <Switch label="Подсветка" checked={on} onChange={setOn} />
        <Slider label="Громкость" min={0} max={100} value={volume} unit=" %" onChange={setVolume} />
        <Stepper label="Температура" min={16} max={30} value={temperature} unit="°C" onChange={setTemperature} />
      </section>
      <section><h2>Приборы</h2><div className="cc-gallery-row">{readings.map(([reading, label], i) =>
        <figure key={reading.kind}><RingGauge size={i === 0 ? 148 : i === 1 ? 96 : 64} tone="heat" reading={reading} label={label}>
          {reading.kind === "progress" ? "64 %" : <Icon name="coffee" />}</RingGauge><figcaption>{label}</figcaption></figure>)}</div></section>
      {jarvisEnabled && <section><h2>Jarvis</h2><div className="cc-orb-gallery">{orbStates.map(([state, label]) =>
        <figure key={state}><JarvisOrb state={state} /><figcaption>{label}</figcaption></figure>)}</div></section>}
      <section><h2>Состояния</h2><EmptyState kicker="Календарь" title="Нет событий" />
        <ErrorState title="Данные недоступны" /><Skeleton />
        <Button onClick={() => setBoot(!boot)}>{boot ? "Скрыть загрузку" : "Показать загрузку"}</Button>
        {boot && <BootScreen label="Загружаем данные…" />}
      </section>
    </div>
  </section>;
}
