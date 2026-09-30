// Globalne ustawienia appki, NIEZALEŻNE od workspace'u — w odróżnieniu od
// workspace.svelte.ts (wsGet/wsSet), który jest per-workspace. Dziś tylko
// czułość zoomu/przesuwania płótna, współdzielona przez wszystkie płótna
// (Node Graph *i* Tablica) — patrz sidecar main.py, sekcja "Ustawienia
// globalne appki".

const BASE = "http://127.0.0.1:7432";

let _cache = $state<Record<string, unknown>>({});
let _loaded = $state(false);
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadAppSettings(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/app_settings`);
    _cache = r.ok ? await r.json() : {};
  } catch {
    _cache = {};
  }
  _loaded = true;
}

export function appSettingsLoaded(): boolean {
  return _loaded;
}

export function getSetting<T>(key: string, fallback: T): T {
  return key in _cache ? (_cache[key] as T) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  _cache[key] = value;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { saveAppSettings(); }, 500);
}

export async function saveAppSettings(): Promise<void> {
  try {
    await fetch(`${BASE}/app_settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_cache),
    });
  } catch {}
}
