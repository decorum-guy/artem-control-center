interface MusicOption {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export interface MusicProjection {
  connection: string;
  channel: string | null;
  destination: string;
  canChoose: boolean;
  canStart?: boolean;
  busyEvents: number;
  operation: { id: string; status: string; title: string | null; options: MusicOption[] } | null;
}

export const resultLabels: Record<string, string> = {
  working: "Проверяем песню…",
  choose_source: "Какая песня играла, когда ты произнёс команду?",
  choose_version: "Какую запись сохранить?",
  no_match: "Подходящая запись не найдена.",
  no_track: "На Мини 2 нет подтверждённого играющего трека.",
  already_in_music: "Уже есть в понравившейся музыке.",
  in_music: "Песня появилась в понравившейся музыке.",
  youtube_like: "Лайк подтверждён в YouTube. Появление в понравившейся музыке пока не подтверждено.",
  unconfirmed: "Результат записи не подтверждён.",
  auth_required: "Подключи нужный канал Google.",
  unavailable: "Не удалось связаться с Music.",
  blocked: "Сохранение недоступно в текущем профиле."
};

export const musicSaveEndpoint = "/api/v1/station/music-save";

export async function submitMusicSave(path: "start" | "choose", body: object): Promise<MusicProjection> {
  const response = await fetch(`${musicSaveEndpoint}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Panel-Intent": "music-save" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.detail === "string" ? error.detail : "unconfirmed");
  }
  return await response.json() as MusicProjection;
}
