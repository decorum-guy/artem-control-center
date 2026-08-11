import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import {
  addWeatherLocation,
  deleteWeatherLocation,
  fetchWeather,
  fetchWeatherLocations,
  previewWeather,
  renameWeatherLocation,
  reorderWeatherLocations,
  searchWeatherLocations,
  setDefaultWeatherLocation,
  type WeatherCandidate,
  type WeatherForecast,
  type WeatherLocation,
  type WeatherSearchResult
} from "./weatherApi";

interface WeatherContextValue {
  locations: WeatherLocation[];
  activeLocationId: string | null;
  forecast: WeatherForecast | null;
  loading: boolean;
  error: string | null;
  selectLocation: (locationId: string) => Promise<void>;
  refresh: () => Promise<void>;
  addLocation: (candidate: WeatherCandidate) => Promise<WeatherLocation>;
  renameLocation: (locationId: string, title: string) => Promise<void>;
  removeLocation: (locationId: string) => Promise<void>;
  makeDefault: (locationId: string) => Promise<void>;
  moveLocation: (locationId: string, direction: -1 | 1) => Promise<void>;
}

const WeatherContext = createContext<WeatherContextValue | null>(null);
const ACTIVE_LOCATION_KEY = "artem.weather.active-location";

export function weatherKind(code: number): "clear" | "partly" | "cloudy" | "fog" | "rain" | "snow" | "storm" {
  if (code === 0) return "clear";
  if (code <= 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
}

export function weatherLabel(code: number): string {
  if (code === 0) return "Ясно";
  if (code === 1) return "Преимущественно ясно";
  if (code === 2) return "Переменная облачность";
  if (code === 3) return "Облачно";
  if (code === 45 || code === 48) return "Туман";
  if (code >= 51 && code <= 57) return "Морось";
  if (code >= 61 && code <= 67) return "Дождь";
  if (code >= 71 && code <= 77) return "Снег";
  if (code >= 80 && code <= 82) return "Ливни";
  if (code === 85 || code === 86) return "Снегопад";
  if (code >= 95) return "Гроза";
  return "Погода меняется";
}

function WeatherGlyph({ code, compact = false }: { code: number; compact?: boolean }) {
  const kind = weatherKind(code);
  const glyph = {
    clear: "☀",
    partly: "◒",
    cloudy: "☁",
    fog: "≋",
    rain: "☂",
    snow: "❄",
    storm: "ϟ"
  }[kind];
  return <span className={`weather-glyph weather-glyph--${kind} ${compact ? "weather-glyph--compact" : ""}`} aria-hidden="true">{glyph}</span>;
}

function formatTemperature(value: number): string {
  return `${Math.round(value)}°`;
}

function formatClock(value: string): string {
  const time = value.includes("T") ? value.split("T")[1] : value;
  return time.slice(0, 5);
}

function formatWeekday(value: string, short = false): string {
  const date = new Date(`${value}T12:00:00`);
  const formatted = date.toLocaleDateString("ru-RU", { weekday: short ? "short" : "long" });
  return formatted.replace(".", "");
}

function ageLabel(seconds: number): string {
  if (seconds < 90) return "только что";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} мин назад`;
  return `${Math.max(1, Math.round(seconds / 3600))} ч назад`;
}

function describeError(error: unknown): string {
  const code = error instanceof Error ? error.message : "weather_unknown_error";
  if (code.includes("geocoder")) return "Поиск мест сейчас недоступен";
  if (code.includes("provider")) return "Прогноз сейчас недоступен";
  if (code.includes("location_not_found")) return "Сохранённое место не найдено";
  return "Не удалось обновить погоду";
}

export function WeatherProvider({ children }: { children: ReactNode }) {
  const [locations, setLocations] = useState<WeatherLocation[]>([]);
  const [activeLocationId, setActiveLocationId] = useState<string | null>(null);
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadForecast = useCallback(async (locationId?: string, force = false) => {
    setLoading(true);
    try {
      const next = await fetchWeather(locationId, force);
      setForecast(next);
      setError(null);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const nextLocations = await fetchWeatherLocations();
      setLocations(nextLocations);
      const stored = window.localStorage.getItem(ACTIVE_LOCATION_KEY);
      const chosen = nextLocations.find((item) => item.id === stored)
        ?? nextLocations.find((item) => item.isDefault)
        ?? nextLocations[0]
        ?? null;
      setActiveLocationId(chosen?.id ?? null);
      if (chosen) {
        await loadForecast(chosen.id);
      } else {
        setForecast(null);
        setLoading(false);
      }
    } catch (nextError) {
      setError(describeError(nextError));
      setLoading(false);
    }
  }, [loadForecast]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const selectLocation = useCallback(async (locationId: string) => {
    setActiveLocationId(locationId);
    window.localStorage.setItem(ACTIVE_LOCATION_KEY, locationId);
    await loadForecast(locationId);
  }, [loadForecast]);

  const refresh = useCallback(async () => {
    if (activeLocationId) await loadForecast(activeLocationId, true);
  }, [activeLocationId, loadForecast]);

  const reloadLocations = useCallback(async () => {
    const next = await fetchWeatherLocations();
    setLocations(next);
    return next;
  }, []);

  const addLocation = useCallback(async (candidate: WeatherCandidate) => {
    const added = await addWeatherLocation(candidate);
    await reloadLocations();
    await selectLocation(added.id);
    return added;
  }, [reloadLocations, selectLocation]);

  const renameLocation = useCallback(async (locationId: string, title: string) => {
    await renameWeatherLocation(locationId, title);
    await reloadLocations();
    if (activeLocationId === locationId) await loadForecast(locationId);
  }, [activeLocationId, loadForecast, reloadLocations]);

  const removeLocation = useCallback(async (locationId: string) => {
    await deleteWeatherLocation(locationId);
    const next = await reloadLocations();
    if (activeLocationId === locationId) {
      const fallback = next.find((item) => item.isDefault) ?? next[0] ?? null;
      setActiveLocationId(fallback?.id ?? null);
      if (fallback) {
        window.localStorage.setItem(ACTIVE_LOCATION_KEY, fallback.id);
        await loadForecast(fallback.id);
      } else {
        window.localStorage.removeItem(ACTIVE_LOCATION_KEY);
        setForecast(null);
      }
    }
  }, [activeLocationId, loadForecast, reloadLocations]);

  const makeDefault = useCallback(async (locationId: string) => {
    await setDefaultWeatherLocation(locationId);
    await reloadLocations();
  }, [reloadLocations]);

  const moveLocation = useCallback(async (locationId: string, direction: -1 | 1) => {
    const index = locations.findIndex((item) => item.id === locationId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= locations.length) return;
    const ids = locations.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setLocations(await reorderWeatherLocations(ids));
  }, [locations]);

  const value = useMemo<WeatherContextValue>(() => ({
    locations,
    activeLocationId,
    forecast,
    loading,
    error,
    selectLocation,
    refresh,
    addLocation,
    renameLocation,
    removeLocation,
    makeDefault,
    moveLocation
  }), [
    locations,
    activeLocationId,
    forecast,
    loading,
    error,
    selectLocation,
    refresh,
    addLocation,
    renameLocation,
    removeLocation,
    makeDefault,
    moveLocation
  ]);

  return <WeatherContext.Provider value={value}>{children}</WeatherContext.Provider>;
}

export function useWeather() {
  const value = useContext(WeatherContext);
  if (!value) throw new Error("useWeather must be used inside WeatherProvider");
  return value;
}

export function WeatherHeaderSummary({ onOpen }: { onOpen: () => void }) {
  const { forecast, loading, error } = useWeather();
  return (
    <button className="weather-summary" type="button" onClick={onOpen} aria-label="Открыть погоду">
      <span>{forecast?.location.title ?? "Погода"}</span>
      <strong>
        {forecast
          ? `${formatTemperature(forecast.current.temperature)} · ${weatherLabel(forecast.current.weatherCode)}`
          : loading
            ? "Обновляем прогноз…"
            : error ?? "Добавьте место"}
      </strong>
    </button>
  );
}

function WeatherHero({ forecast, preview }: { forecast: WeatherForecast; preview: boolean }) {
  const kind = weatherKind(forecast.current.weatherCode);
  const today = forecast.daily[0];
  return (
    <section className={`weather-hero weather-hero--${kind}`} data-testid="weather-hero">
      <div className="weather-ambient" aria-hidden="true">
        <i className="weather-ambient__orb" />
        <i className="weather-ambient__cloud weather-ambient__cloud--one" />
        <i className="weather-ambient__cloud weather-ambient__cloud--two" />
        <i className="weather-ambient__streaks" />
      </div>
      <div className="weather-hero__content">
        <div className="weather-hero__location">
          <div>
            <p className="section-kicker">{preview ? "Предпросмотр" : "Сейчас"}</p>
            <h1>{forecast.location.title}</h1>
            <span>{forecast.location.normalizedAddress}</span>
          </div>
          <div className="weather-freshness">
            <span className={forecast.stale ? "weather-freshness--stale" : ""}>
              {forecast.stale ? "Данные устарели" : `Обновлено ${ageLabel(forecast.ageSeconds)}`}
            </span>
            <small>{forecast.sourceMode === "fixture" ? "Fixture" : forecast.timezoneAbbreviation}</small>
          </div>
        </div>

        <div className="weather-hero__primary">
          <div className="weather-temperature">
            <strong>{formatTemperature(forecast.current.temperature)}</strong>
            <span>{weatherLabel(forecast.current.weatherCode)}</span>
          </div>
          <WeatherGlyph code={forecast.current.weatherCode} />
        </div>

        <div className="weather-hero__bottom">
          <div className="weather-metrics">
            <div><span>Ощущается</span><strong>{formatTemperature(forecast.current.apparentTemperature)}</strong></div>
            <div><span>Осадки</span><strong>{forecast.current.precipitation.toFixed(1)} мм</strong></div>
            <div><span>Ветер</span><strong>{Math.round(forecast.current.windSpeed)} км/ч</strong></div>
            {today && <div><span>Сегодня</span><strong>{formatTemperature(today.temperatureMax)} / {formatTemperature(today.temperatureMin)}</strong></div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function HourlyForecast({ forecast }: { forecast: WeatherForecast }) {
  return (
    <section className="weather-section" aria-labelledby="weather-hourly-title">
      <header className="weather-section__heading">
        <div>
          <p className="section-kicker">Ближайшие часы</p>
          <h2 id="weather-hourly-title">Почасовой прогноз</h2>
        </div>
        <span>24 часа</span>
      </header>
      <div className="weather-hourly" role="list">
        {forecast.hourly.map((hour, index) => (
          <article className={`weather-hour ${index === 0 ? "weather-hour--now" : ""}`} key={`${hour.time}-${index}`} role="listitem">
            <time>{index === 0 ? "Сейчас" : formatClock(hour.time)}</time>
            <WeatherGlyph code={hour.weatherCode} compact />
            <strong>{formatTemperature(hour.temperature)}</strong>
            <span className={hour.precipitationProbability >= 40 ? "weather-rain-chance--active" : ""}>
              {hour.precipitationProbability}%
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

function DailyForecast({ forecast }: { forecast: WeatherForecast }) {
  return (
    <section className="weather-section" aria-labelledby="weather-daily-title">
      <header className="weather-section__heading">
        <div>
          <p className="section-kicker">Неделя</p>
          <h2 id="weather-daily-title">7 дней</h2>
        </div>
      </header>
      <div className="weather-days">
        {forecast.daily.map((day, index) => (
          <article className="weather-day" key={day.date}>
            <div className="weather-day__name">
              <strong>{index === 0 ? "Сегодня" : formatWeekday(day.date)}</strong>
              <span>{new Date(`${day.date}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span>
            </div>
            <WeatherGlyph code={day.weatherCode} compact />
            <span className="weather-day__condition">{weatherLabel(day.weatherCode)}</span>
            <span className={day.precipitationProbabilityMax >= 40 ? "weather-rain-chance--active" : ""}>{day.precipitationProbabilityMax}%</span>
            <div className="weather-day__temperatures"><strong>{formatTemperature(day.temperatureMax)}</strong><span>{formatTemperature(day.temperatureMin)}</span></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SunCard({ forecast }: { forecast: WeatherForecast }) {
  const today = forecast.daily[0];
  if (!today) return null;
  return (
    <section className="weather-sun-card">
      <div>
        <p className="section-kicker">Световой день</p>
        <h2>Солнце</h2>
      </div>
      <div className="weather-sun-arc" aria-hidden="true"><i /></div>
      <dl>
        <div><dt>Восход</dt><dd>{formatClock(today.sunrise)}</dd></div>
        <div><dt>Закат</dt><dd>{formatClock(today.sunset)}</dd></div>
      </dl>
      <p>Время рассчитано для выбранной точки и её локального часового пояса.</p>
    </section>
  );
}

function LocationSearch({
  onPreview,
  onClose
}: {
  onPreview: (candidate: WeatherCandidate, forecast: WeatherForecast) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await searchWeatherLocations(query.trim()));
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function choose(result: WeatherSearchResult) {
    setBusy(true);
    setError(null);
    const candidate: WeatherCandidate = {
      title: result.title,
      normalizedAddress: result.normalizedAddress,
      latitude: result.latitude,
      longitude: result.longitude
    };
    try {
      const next = await previewWeather(candidate);
      onPreview(candidate, next);
      onClose();
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="weather-location-search" data-testid="weather-location-search">
      <header>
        <div><p className="section-kicker">Новое место</p><h2>Куда смотрим?</h2></div>
        <button type="button" className="weather-icon-button" onClick={onClose} aria-label="Закрыть поиск">×</button>
      </header>
      <form onSubmit={submit}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Город, район или адрес"
          autoComplete="off"
          aria-label="Поиск места"
        />
        <button type="submit" disabled={busy || query.trim().length < 2}>{busy ? "Ищем…" : "Найти"}</button>
      </form>
      {error && <p className="weather-inline-error" role="alert">{error}</p>}
      <div className="weather-search-results">
        {results.map((result) => (
          <button type="button" key={result.providerId} onClick={() => void choose(result)} disabled={busy}>
            <strong>{result.title}</strong>
            <span>{result.normalizedAddress}</span>
          </button>
        ))}
        {!busy && query.length >= 2 && results.length === 0 && !error && <p>Введите запрос и выберите найденную точку для предпросмотра.</p>}
      </div>
      <small className="weather-attribution">Поиск мест: OpenStreetMap contributors · Nominatim</small>
    </section>
  );
}

function LocationManager() {
  const { locations, renameLocation, removeLocation, makeDefault, moveLocation } = useWeather();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(Object.fromEntries(locations.map((item) => [item.id, item.title])));
  }, [locations]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="weather-location-manager">
      <header className="weather-section__heading">
        <div><p className="section-kicker">Настройка</p><h2>Мои места</h2></div>
        <span>Хранятся только локально</span>
      </header>
      {error && <p className="weather-inline-error" role="alert">{error}</p>}
      <div className="weather-location-list">
        {locations.map((location, index) => (
          <article key={location.id}>
            <div className="weather-location-list__identity">
              <input
                value={drafts[location.id] ?? location.title}
                onChange={(event) => setDrafts((current) => ({ ...current, [location.id]: event.target.value }))}
                aria-label={`Название ${location.title}`}
              />
              <span>{location.normalizedAddress}</span>
            </div>
            <div className="weather-location-list__actions">
              <button type="button" onClick={() => void run(`rename-${location.id}`, () => renameLocation(location.id, (drafts[location.id] ?? location.title).trim()))} disabled={busy !== null || !(drafts[location.id] ?? "").trim()}>Сохранить</button>
              <button type="button" onClick={() => void run(`default-${location.id}`, () => makeDefault(location.id))} disabled={busy !== null || location.isDefault}>{location.isDefault ? "По умолчанию" : "Сделать основной"}</button>
              <button type="button" className="weather-icon-button" onClick={() => void run(`up-${location.id}`, () => moveLocation(location.id, -1))} disabled={busy !== null || index === 0} aria-label={`Поднять ${location.title}`}>↑</button>
              <button type="button" className="weather-icon-button" onClick={() => void run(`down-${location.id}`, () => moveLocation(location.id, 1))} disabled={busy !== null || index === locations.length - 1} aria-label={`Опустить ${location.title}`}>↓</button>
              <button type="button" className="weather-danger-button" onClick={() => void run(`delete-${location.id}`, () => removeLocation(location.id))} disabled={busy !== null}>Удалить</button>
            </div>
          </article>
        ))}
        {!locations.length && <p className="muted">Сохранённых мест пока нет.</p>}
      </div>
    </section>
  );
}

export function WeatherPage() {
  const {
    locations,
    activeLocationId,
    forecast,
    loading,
    error,
    selectLocation,
    refresh,
    addLocation
  } = useWeather();
  const [searchOpen, setSearchOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [preview, setPreview] = useState<WeatherForecast | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<WeatherCandidate | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const visibleForecast = preview ?? forecast;

  async function savePreview() {
    if (!previewCandidate) return;
    setSaving(true);
    setMutationError(null);
    try {
      await addLocation(previewCandidate);
      setPreview(null);
      setPreviewCandidate(null);
    } catch (nextError) {
      setMutationError(describeError(nextError));
    } finally {
      setSaving(false);
    }
  }

  function chooseSaved(locationId: string) {
    setPreview(null);
    setPreviewCandidate(null);
    void selectLocation(locationId);
  }

  return (
    <div className="weather-page" data-testid="route-weather">
      <div className="weather-toolbar">
        <div className="weather-location-tabs" role="tablist" aria-label="Сохранённые места">
          {locations.map((location) => (
            <button
              type="button"
              role="tab"
              aria-selected={!preview && activeLocationId === location.id}
              key={location.id}
              onClick={() => chooseSaved(location.id)}
            >
              {location.title}
              {location.isDefault && <i aria-label="Основное место">•</i>}
            </button>
          ))}
        </div>
        <div className="weather-toolbar__actions">
          <button type="button" onClick={() => setSearchOpen((value) => !value)}>+ Место</button>
          <button type="button" onClick={() => setManagerOpen((value) => !value)}>Управление</button>
          <button type="button" className="weather-icon-button" onClick={() => void refresh()} disabled={loading || Boolean(preview)} aria-label="Обновить прогноз">↻</button>
        </div>
      </div>

      {searchOpen && (
        <LocationSearch
          onClose={() => setSearchOpen(false)}
          onPreview={(candidate, nextForecast) => {
            setPreviewCandidate(candidate);
            setPreview(nextForecast);
          }}
        />
      )}

      {preview && previewCandidate && (
        <div className="weather-preview-bar" role="status">
          <div><strong>Это предпросмотр</strong><span>Проверьте точку и прогноз перед сохранением.</span></div>
          <button type="button" onClick={() => { setPreview(null); setPreviewCandidate(null); }}>Отмена</button>
          <button type="button" className="weather-primary-button" onClick={() => void savePreview()} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить место"}</button>
        </div>
      )}

      {mutationError && <p className="weather-inline-error" role="alert">{mutationError}</p>}
      {error && !visibleForecast && <section className="weather-empty"><strong>{error}</strong><p>Добавьте место или попробуйте обновить данные.</p></section>}
      {loading && !visibleForecast && <section className="weather-empty"><strong>Собираем прогноз…</strong><p>Проверяем выбранную точку и часовой пояс.</p></section>}

      {visibleForecast && (
        <>
          <WeatherHero forecast={visibleForecast} preview={Boolean(preview)} />
          {visibleForecast.stale && (
            <div className="weather-stale-banner" role="status">
              <strong>Показываем последний сохранённый прогноз</strong>
              <span>Свежие данные сейчас недоступны; значения не выдаются за текущие.</span>
            </div>
          )}
          <div className="weather-content-grid">
            <div className="weather-content-main">
              <HourlyForecast forecast={visibleForecast} />
              <DailyForecast forecast={visibleForecast} />
            </div>
            <aside className="weather-content-aside">
              <SunCard forecast={visibleForecast} />
              <section className="weather-source-card">
                <p className="section-kicker">Источник</p>
                <h2>Open‑Meteo</h2>
                <p>{visibleForecast.attribution}. Точка прогноза определяется по сохранённым координатам; свежесть показывается отдельно.</p>
              </section>
            </aside>
          </div>
        </>
      )}

      {managerOpen && <LocationManager />}
    </div>
  );
}
