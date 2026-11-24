import { useSyncExternalStore } from "react";

export type Provider = "yandex" | "youtube";
export interface Playlist {
  key: string;
  title: string;
  kind: "liked" | "playlist";
  cover: string | null;
  count: number | null;
}
export interface Recording {
  key: string;
  trackId: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration: number | null;
  cover: string | null;
  playable: boolean;
}
interface Page<T> { items: T[]; next: string | null; generation: string; observedAt: string }
export interface PlayResult {
  status: string;
  stationTrackId?: string | null;
  options?: Recording[];
  yandexGeneration?: string;
}

const root = "/api/v1/music/";
const MAX_ROWS = 2400;
const KEPT_PLAYLISTS = 4;
const KEPT_VIEWS = 500;
const KEPT_MATCHES = 128;
const MAX_WINDOW_PAGES = 64;

interface Segment { cursor: string | null; size: number }
interface TrackView {
  query: string;
  scroll: number;
  bookmark?: { cursor: string | null; depth: number; omitted: number };
  anchor?: { trackId: string; index: number };
}

interface TrackData {
  items: Recording[];
  next: string | null;
  segments: Segment[];
  observedAt: string | null;
  pending: boolean;
  error: string | null;
  omitted: number;
  changesAvailable?: boolean;
  movedToStart?: boolean;
}
type TrackList = TrackData & TrackView;

interface LibraryState {
  generation: string | null;
  status: string;
  canPlay: boolean;
  yandexGeneration: string | null;
  matches: Record<string, string>;
  likedRevision: number;
  playlists: Playlist[];
  catalogNext: string | null;
  catalogPending: boolean;
  catalogRefreshing: boolean;
  catalogError: string | null;
  catalogRemoved: boolean;
  selected: string | null;
  lists: Record<string, TrackData>;
}

const emptyData: TrackData = {
  items: [], next: null, segments: [], observedAt: null, pending: false, error: null, omitted: 0
};
const emptyView: TrackView = { scroll: 0, query: "" };
const initial: LibraryState = {
  generation: null, status: "connecting", canPlay: false, yandexGeneration: null, matches: {}, likedRevision: 0,
  playlists: [], catalogNext: null, catalogPending: false, catalogRefreshing: false,
  catalogError: null, catalogRemoved: false, selected: null, lists: {}
};

export function filterTracks(items: Recording[], query: string) {
  const term = query.trim().toLocaleLowerCase("ru");
  return term ? items.filter(item => `${item.title} ${item.artist}`.toLocaleLowerCase("ru").includes(term)) : items;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(24_000), ...init });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(error?.detail ?? (response.status === 404 ? "not_configured" : "source_unavailable"));
  }
  return response.json() as Promise<T>;
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : "source_unavailable";
}

function savedSelection(provider: Provider, generation: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`panel.music.${provider}`) ?? "null") as
      { generation: string; source: string } | null;
    return saved?.generation === generation ? saved.source : null;
  } catch {
    return null;
  }
}

function saveSelection(provider: Provider, generation: string, source: string | null) {
  try {
    sessionStorage.setItem(`panel.music.${provider}`, JSON.stringify({ generation, source }));
  } catch {
    // Navigation still preserves the in-memory selection.
  }
}

export class MusicLibraryStore {
  private state: LibraryState = initial;
  private listeners = new Set<() => void>();
  private listRequests = new Map<string, AbortController>();
  private views = new Map<string, TrackView>();
  private catalogRequest: AbortController | null = null;
  private statusRequest: Promise<void> | null = null;
  private loadedCatalog = false;

  constructor(readonly provider: Provider) {}
  read = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private patch(patch: Partial<LibraryState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  sync = () => {
    if (this.statusRequest) return this.statusRequest;
    this.statusRequest = this.checkStatus().finally(() => { this.statusRequest = null; });
    return this.statusRequest;
  };

  private async checkStatus() {
    try {
      const status = await request<Pick<LibraryState, "generation" | "status" | "canPlay" | "likedRevision" | "yandexGeneration">>(
        `${root}${this.provider}/status`);
      if (this.state.generation !== status.generation) {
        this.listRequests.forEach(controller => controller.abort());
        this.listRequests.clear();
        this.views.clear();
        this.catalogRequest?.abort();
        this.catalogRequest = null;
        this.loadedCatalog = false;
        this.patch({ ...initial, ...status });
      } else {
        const likedChanged = status.likedRevision > this.state.likedRevision && this.provider === "youtube";
        this.patch({ ...status, matches: status.yandexGeneration === this.state.yandexGeneration ? this.state.matches : {} });
        if (likedChanged && this.state.selected === "LM") {
          const likes = this.getList("LM");
          if (!likes.pending && likes.items.length <= 100 && likes.scroll === 0) {
            void this.tracks(false, true);
          } else {
            this.writeData("LM", { changesAvailable: true });
          }
        } else if (likedChanged && this.state.selected !== "LM" && this.state.lists.LM) {
          const lists = { ...this.state.lists };
          delete lists.LM;
          this.patch({ lists });
        }
      }
      if (status.status !== "auth_required" && status.status !== "not_configured" && !this.loadedCatalog) {
        await this.catalog();
      }
    } catch (error) {
      this.patch({ status: errorCode(error) === "not_configured" ? "not_configured" : "unavailable" });
    }
  }

  async catalog(more = false, refresh = false) {
    const { generation, catalogPending, catalogNext } = this.state;
    if (!generation || (!refresh && catalogPending) || (more && !catalogNext)) return;
    this.catalogRequest?.abort();
    const controller = new AbortController();
    this.catalogRequest = controller;
    this.patch({ catalogPending: true, catalogRefreshing: refresh, catalogError: null });
    const params = new URLSearchParams();
    if (more && catalogNext) params.set("cursor", catalogNext);
    if (refresh) params.set("refresh", "true");
    const current = () => this.catalogRequest === controller && this.state.generation === generation;
    try {
      const page = await request<Page<Playlist>>(`${root}${this.provider}/catalog?${params}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(24_000)])
      });
      if (!current() || page.generation !== generation) return;
      const previous = more ? this.state.playlists : [];
      const keys = new Set(previous.map(item => item.key));
      const playlists = previous.concat(page.items.filter(item => !keys.has(item.key)));
      const selection = this.state.selected;
      this.loadedCatalog = true;
      if (refresh && selection && !playlists.some(item => item.key === selection)) {
        this.cancelTracks(selection);
        this.views.delete(selection);
        const lists = { ...this.state.lists };
        delete lists[selection];
        saveSelection(this.provider, generation, null);
        this.patch({ selected: null, lists, catalogRemoved: true });
      }
      this.patch({ playlists, catalogNext: page.next, status: "ready" });
      const restored = savedSelection(this.provider, generation);
      if (!this.state.selected && (this.provider === "yandex" || (restored && playlists.some(item => item.key === restored)))) {
        this.select(restored ?? playlists[0]?.key);
      }
    } catch (error) {
      if (current()) this.patch({ catalogError: errorCode(error) });
    } finally {
      if (current()) {
        this.catalogRequest = null;
        this.patch({ catalogPending: false, catalogRefreshing: false });
      }
    }
  }

  getList(source: string | null): TrackList {
    return source ? { ...(this.state.lists[source] ?? emptyData), ...(this.views.get(source) ?? emptyView) }
      : { ...emptyData, ...emptyView };
  }

  private remember(source: string, patch: Partial<TrackView>) {
    const view = { ...(this.views.get(source) ?? emptyView), ...patch };
    this.views.delete(source);
    this.views.set(source, view);
    if (this.views.size > KEPT_VIEWS) this.views.delete(this.views.keys().next().value!);
  }

  private writeData(source: string, patch: Partial<TrackData>) {
    const lists = { ...this.state.lists };
    const updated = { ...(lists[source] ?? emptyData), ...patch };
    delete lists[source];
    lists[source] = updated;
    const oldest = Object.keys(lists).find(key => key !== source && key !== this.state.selected && !lists[key].pending);
    if (Object.keys(lists).length > KEPT_PLAYLISTS && oldest) delete lists[oldest];
    this.patch({ lists });
  }

  private cancelTracks(source: string) {
    this.listRequests.get(source)?.abort();
    this.listRequests.delete(source);
  }

  select(source: string | undefined) {
    if (!source || !this.state.playlists.some(item => item.key === source)) return;
    const previous = this.state.selected;
    if (source !== previous && previous && this.listRequests.has(previous)) {
      this.cancelTracks(previous);
      this.writeData(previous, { pending: false });
    }
    this.patch({ selected: source, catalogRemoved: false });
    if (this.state.generation) saveSelection(this.provider, this.state.generation, source);
    if (this.getList(source).observedAt) this.writeData(source, {});
    else void this.tracks();
  }

  scroll(value: number, trackId: string | null | undefined) {
    const { selected } = this.state;
    if (!selected) return;
    const list = this.getList(selected);
    if (list.scroll === value) return;
    const index = Math.floor(value / MUSIC_ROW_HEIGHT);
    this.remember(selected, { scroll: value, anchor: trackId ? { trackId, index } : undefined });
    this.patch({});
  }

  search(value: string) {
    if (!this.state.selected) return;
    this.remember(this.state.selected, { query: value, scroll: 0, anchor: undefined });
    this.patch({});
  }

  async tracks(more = false, refresh = false) {
    const { generation, selected } = this.state;
    const list = this.getList(selected);
    if (!generation || !selected || list.pending || (more && !list.next)) return;
    const controller = new AbortController();
    this.listRequests.set(selected, controller);
    this.writeData(selected, { pending: true, error: null, movedToStart: false });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(24_000)]);
    function load(provider: Provider, cursor: string | null, refreshFirst = false) {
      const search = new URLSearchParams();
      if (cursor) search.set("cursor", cursor);
      if (refreshFirst) search.set("refresh", "true");
      return request<Page<Recording>>(`${root}${provider}/tracks/${selected}?${search}`, { signal });
    }
    const bookmark = !more && !refresh && !list.observedAt ? list.bookmark : undefined;
    let cursor = more ? list.next : bookmark?.cursor ?? null;
    let depth = bookmark?.depth ?? 1;
    let omitted = more ? list.omitted : bookmark?.omitted ?? 0;
    let movedToStart = false;
    try {
      const items = more ? [...list.items] : [];
      const segments = more ? [...list.segments] : [];
      const current = () => this.listRequests.get(selected) === controller && generation === this.state.generation;
      let page;
      try {
        page = await load(this.provider, cursor, refresh);
      } catch (error) {
        if (!bookmark || !cursor || errorCode(error) !== "page_expired") throw error;
        cursor = null;
        depth = 1;
        omitted = 0;
        movedToStart = true;
        page = await load(this.provider, null);
      }
      for (let index = 0; index < depth; index++) {
        if (!current() || page.generation !== generation) return;
        segments.push({ cursor, size: page.items.length });
        items.push(...page.items);
        cursor = page.next;
        if (!cursor || index + 1 === depth) break;
        page = await load(this.provider, cursor);
      }
      let drop = 0;
      while (segments.length > 1 && (items.length - drop > MAX_ROWS || segments.length > MAX_WINDOW_PAGES)) {
        drop += segments.shift()!.size;
      }
      const view = this.getList(selected);
      const removedVisible = filterTracks(items.slice(0, drop), view.query).length;
      const nextItems = items.slice(drop);
      let scroll = Math.max(0, (more || (bookmark && !movedToStart) ? view.scroll : 0) - removedVisible * MUSIC_ROW_HEIGHT);
      let anchor = more ? view.anchor : undefined;
      if (bookmark && !movedToStart && view.anchor) {
        // A refreshed provider page may move a track. Use the nearest occurrence of its ID.
        const { trackId, index } = view.anchor;
        let nearest = -1;
        filterTracks(nextItems, view.query).forEach((item, offset) => {
          if (item.trackId === trackId && (nearest < 0 || Math.abs(offset - index) < Math.abs(nearest - index))) nearest = offset;
        });
        if (nearest >= 0) {
          scroll = nearest * MUSIC_ROW_HEIGHT + view.scroll % MUSIC_ROW_HEIGHT;
          anchor = { trackId, index: nearest };
        }
      }
      this.remember(selected, {
        scroll, anchor, bookmark: { cursor: segments[0]?.cursor ?? null, depth: segments.length, omitted: omitted + drop }
      });
      this.writeData(selected, {
        items: nextItems, segments, next: cursor, observedAt: page.observedAt, omitted: omitted + drop,
        changesAvailable: more ? list.changesAvailable : false, movedToStart
      });
    } catch (error) {
      if (!controller.signal.aborted && generation === this.state.generation) {
        this.writeData(selected, { error: errorCode(error) });
        if (["auth_required", "account_changed"].includes(errorCode(error))) void this.sync();
      }
    } finally {
      if (this.listRequests.get(selected) === controller) {
        this.listRequests.delete(selected);
        this.writeData(selected, { pending: false });
      }
    }
  }

  async play(record: Recording, choice?: string): Promise<PlayResult> {
    const { generation, selected } = this.state;
    if (!generation || !selected) return { status: "unavailable" };
    const result = await request<PlayResult>(`${root}${this.provider}/play`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Panel-Intent": "music-library" },
      body: JSON.stringify({ generation, source: selected, row: record.key, choice })
    });
    if (this.provider === "youtube" && record.trackId && result.stationTrackId && result.yandexGeneration
        && generation === this.state.generation && result.yandexGeneration === this.state.yandexGeneration) {
      const matches = { ...this.state.matches };
      delete matches[record.trackId];
      matches[record.trackId] = result.stationTrackId;
      const keys = Object.keys(matches);
      if (keys.length > KEPT_MATCHES) delete matches[keys[0]];
      this.patch({ matches });
    }
    return result;
  }
}

export const MUSIC_ROW_HEIGHT = 64;
export const libraries = { yandex: new MusicLibraryStore("yandex"), youtube: new MusicLibraryStore("youtube") };
export function useMusicLibrary(provider: Provider) {
  const library = libraries[provider];
  return [library, useSyncExternalStore(library.subscribe, library.read, library.read)] as const;
}
