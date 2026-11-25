import type { StationRetention } from "@artem/contracts";

const outcomes: Record<StationRetention["samples"][number]["outcome"], string> = {
  cleared: "Станция убрала трек",
  new_media: "Включилось другое медиа",
  resumed: "Воспроизведение продолжилось",
  signal_lost: "Потеряна связь"
};

function duration(seconds: number) {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes} мин ${remainder} с` : `${remainder} с`;
}

export function StationRetentionSettings({ retention }: { retention: StationRetention }) {
  const completed = retention.samples.filter(sample => sample.outcome === "cleared")
    .map(sample => sample.seconds).sort((left, right) => left - right);
  const midpoint = Math.floor(completed.length / 2);
  const median = completed.length % 2 === 0
    ? (completed[midpoint - 1] + completed[midpoint]) / 2
    : completed[midpoint];
  return <details className="station-retention-settings" data-testid="station-retention-settings">
    <summary>Станция · хранение трека после паузы</summary>
    <p>Станция сообщает паузу и остановку одинаково. В статистику входят только замеры до исчезновения трека.</p>
    {retention.activeSince && <p>Текущий замер начат {new Date(retention.activeSince).toLocaleString("ru-RU")}.</p>}
    {completed.length > 0
      ? <p>Замеров: {completed.length}. Минимум {duration(completed[0])}, медиана {duration(median)}, максимум {duration(completed[completed.length - 1])}.</p>
      : <p>Завершённых замеров пока нет.</p>}
    {retention.samples.length > 0 && <ul>
      {retention.samples.slice(0, 12).map((sample, index) => <li key={`${sample.startedAt}-${index}`}>
        {new Date(sample.endedAt).toLocaleString("ru-RU")} · {duration(sample.seconds)} · {outcomes[sample.outcome]}
      </li>)}
    </ul>}
  </details>;
}
