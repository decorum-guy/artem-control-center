import { useEffect, useMemo, useState } from "react";
import { CoffeeDiaryApiError, uploadCoffeeDiaryPhoto } from "./coffeeDiaryApi";
import "./coffeeUpload.css";

type UploadState = "idle" | "ready" | "uploading" | "success" | "error";

function tokenFromFragment(): string {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const token = params.get("token") ?? "";
  if (token) window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
  return token;
}

function uploadErrorCopy(reason: unknown): string {
  const code = reason instanceof CoffeeDiaryApiError ? reason.code : "";
  if (code === "coffee_diary_upload_token_invalid") return "Ссылка недействительна.";
  if (code === "coffee_diary_upload_token_expired") return "Срок действия ссылки истёк.";
  if (code === "coffee_diary_upload_token_cancelled") return "Ссылка отменена на панели.";
  if (code === "coffee_diary_upload_token_consumed") return "Эта ссылка уже использована.";
  if (code === "coffee_diary_upload_file_too_large") return "Файл слишком большой. Выберите фото до 20 МБ.";
  if (code === "coffee_diary_upload_media_type_invalid") return "Этот формат изображения не поддерживается.";
  if (code === "coffee_diary_upload_dimensions_invalid") return "Размер изображения слишком большой.";
  if (code === "coffee_diary_upload_image_invalid") return "Не удалось прочитать изображение. Выберите другое фото.";
  if (code === "network") return "Не удалось связаться с панелью. Проверьте соединение и повторите.";
  return "Фото не загружено. Повторите попытку.";
}

export function CoffeeUploadPage() {
  const [token] = useState(tokenFromFragment);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>(token ? "idle" : "error");
  const [error, setError] = useState(token ? "" : "Ссылка недействительна.");
  const previewUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function selectFile(next: File | undefined) {
    if (!next) return;
    setFile(next);
    setState("ready");
    setError("");
  }

  async function upload() {
    if (!token || !file || state === "uploading") return;
    setState("uploading");
    setError("");
    try {
      await uploadCoffeeDiaryPhoto(token, file);
      setState("success");
    } catch (reason) {
      setState("error");
      setError(uploadErrorCopy(reason));
    }
  }

  return (
    <main className="coffee-upload-page">
      <section className="coffee-upload-card" aria-labelledby="coffee-upload-title">
        <p className="coffee-upload-kicker">Artem Control Center</p>
        <h1 id="coffee-upload-title">Фото кофе</h1>
        {state === "success" ? (
          <div className="coffee-upload-success" role="status">
            <span className="coffee-upload-success__mark" aria-hidden="true">✓</span>
            <p>Фото загружено.</p>
            <p>Можно вернуться к панели.</p>
          </div>
        ) : (
          <>
            <p className="coffee-upload-description">Выберите или сделайте фотографию</p>
            <label className="coffee-upload-file-button">
              <span>Выбрать фото</span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => selectFile(event.target.files?.[0])}
                data-testid="coffee-upload-file"
              />
            </label>
            {previewUrl && <img className="coffee-upload-preview" src={previewUrl} alt="Предпросмотр выбранного фото" data-testid="coffee-upload-preview" />}
            {file && <p className="coffee-upload-file-name">{file.name}</p>}
            <button
              type="button"
              className="coffee-upload-submit"
              disabled={!file || !token || state === "uploading"}
              onClick={() => void upload()}
              data-testid="coffee-upload-submit"
            >
              {state === "uploading" ? "Загружаем…" : "Загрузить"}
            </button>
            {error && <p className="coffee-upload-error" role="alert">{error}</p>}
          </>
        )}
      </section>
    </main>
  );
}
