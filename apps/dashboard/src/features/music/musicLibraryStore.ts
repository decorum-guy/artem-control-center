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
}

const root = "/api/v1/music/";
const MAX_ROWS = 2400;
const KEPT_PLAYLISTS = 4;

export interface TrackList {
  items: Recording[];
  next: string | null;
  scroll: number;
  query: string;
  observedAt: string | null;
  pending: boolean;
  error: string | null;
  omitted: number;
}
interface LibraryState {
  generation: string | null;
  status: string;
  canPlay: boolean;
  playlists: Playlist[];
  catalogNext: string | null;
  catalogPending: boolean;
  catalogError: string | null;
  selected: string | null;
  lists: Record<string, TrackList>;
}

const emptyList: TrackList = {
  items: [], next: null, scroll: 0, query: "", observedAt: null, pending: false, error: null, omitted: 0
};
const initial: LibraryState = {
  generation: null, status: "connecting", canPlay: false, playlists: [], catalogNext: null, catalogPending: false,
  catalogError: null, selected: null, lists: {}
};

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

function saveSelection(provider: Provider, generation: string, source: string) {
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
      const status = await request<Pick<LibraryState, "generation" | "status" | "canPlay">>(
        `${root}${this.provider}/status`);
      if (this.state.generation !== status.generation) {
        this.listRequests.forEach(controller => controller.abort());
        this.listRequests.clear();
        this.loadedCatalog = false;
        this.patch({ ...initial, ...status });
      } else {
        this.patch(status);
      }
      if (status.status !== "auth_required" && status.status !== "not_configured" && !this.loadedCatalog) {
        await this.catalog();
      }
    } catch (error) {
      this.patch({ status: errorCode(error) === "not_configured" ? "not_configured" : "unavailable" });
    }
  }

  async catalog(more = false) {
    const { generation, catalogPending, catalogNext } = this.state;
    if (!generation || catalogPending || (more && !catalogNext)) return;
    this.patch({ catalogPending: true, catalogError: null });
    try {
      const page = await request<Page<Playlist>>(
        `${root}${this.provider}/catalog${more ? "?cursor=" + encodeURIComponent(catalogNext!) : ""}`);
      if (generation !== this.state.generation || page.generation !== generation) return;
      const previous = more ? this.state.playlists : [];
      const keys = new Set(previous.map(item => item.key));
      const playlists = previous.concat(page.items.filter(item => !keys.has(item.key)));
      this.loadedCatalog = true;
      this.patch({ playlists, catalogNext: page.next, status: "ready" });
      const restored = savedSelection(this.provider, generation);
      if (!this.state.selected && (this.provider === "yandex" || (restored && playlists.some(item => item.key === restored)))) {
        this.select(restored ?? playlists[0]?.key);
      }
    } catch (error) {
      if (this.state.generation === generation) this.patch({ catalogError: errorCode(error) });
    } finally {
      if (this.state.generation === generation) this.patch({ catalogPending: false });
    }
  }

  getList(source: string | null) {
    return source ? this.state.lists[source] ?? emptyList : emptyList;
  }

  private writeList(source: string, next: Partial<TrackList>) {
    const lists = { ...this.state.lists, [source]: { ...this.getList(source), ...next } };
    const victim = Object.keys(lists).find(key => key !== source && key !== this.state.selected && !lists[key].pending);
    if (Object.keys(lists).length > KEPT_PLAYLISTS && victim) delete lists[victim];
    this.patch({ lists });
  }

  select(source: string | undefined) {
    if (!source || !this.state.playlists.some(item => item.key === source)) return;
    if (source !== this.state.selected && this.state.selected) {
      const previous = this.state.selected;
      this.listRequests.get(previous)?.abort();
      this.listRequests.delete(previous);
      this.writeList(previous, { pending: false });
    }
    this.patch({ selected: source });
    if (this.state.generation) saveSelection(this.provider, this.state.generation, source);
    if (!this.getList(source).observedAt) void this.tracks();
  }

  scroll(value: number) {
    if (this.state.selected) this.writeList(this.state.selected, { scroll: value });
  }

  search(value: string) {
    if (this.state.selected) this.writeList(this.state.selected, { query: value, scroll: 0 });
  }

  async tracks(more = false, refresh = false) {
    const { generation, selected } = this.state;
    const list = this.getList(selected);
    if (!generation || !selected || list.pending || (more && !list.next)) return;
    const controller = new AbortController();
    this.listRequests.set(selected, controller);
    this.writeList(selected, { pending: true, error: null });
    const search = new URLSearchParams();
    if (more && list.next) search.set("cursor", list.next);
    if (refresh) search.set("refresh", "true");
    try {
      const page = await request<Page<Recording>>(`${root}${this.provider}/tracks/${selected}?${search}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(24_000)])
      });
      if (controller.signal.aborted || generation !== this.state.generation || page.generation !== generation) return;
      const previous = this.getList(selected);
      const items = more ? previous.items.concat(page.items) : page.items;
      const drop = Math.max(0, items.length - MAX_ROWS);
      this.writeList(selected, {
        items: items.slice(drop), next: page.next, observedAt: page.observedAt,
        omitted: (more ? previous.omitted : 0) + drop,
        scroll: more ? Math.max(0, previous.scroll - drop * MUSIC_ROW_HEIGHT) : 0
      });
    } catch (error) {
      if (!controller.signal.aborted && generation === this.state.generation) {
        this.writeList(selected, { error: errorCode(error) });
        if (["auth_required", "account_changed"].includes(errorCode(error))) void this.sync();
      }
    } finally {
      if (this.listRequests.get(selected) === controller) {
        this.listRequests.delete(selected);
        this.writeList(selected, { pending: false });
      }
    }
  }

  async play(record: Recording, choice?: string): Promise<PlayResult> {
    const { generation, selected } = this.state;
    if (!generation || !selected) return { status: "unavailable" };
    return request<PlayResult>(`${root}${this.provider}/play`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Panel-Intent": "music-library" },
      body: JSON.stringify({ generation, source: selected, row: record.key, choice })
    });
  }
}

export const MUSIC_ROW_HEIGHT = 64;
export const libraries = { yandex: new MusicLibraryStore("yandex"), youtube: new MusicLibraryStore("youtube") };
export function useMusicLibrary(provider: Provider) {
  const library = libraries[provider];
  return [library, useSyncExternalStore(library.subscribe, library.read, library.read)] as const;
}
