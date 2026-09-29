import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Theme = "system" | "dark" | "light" | "midnight";
export type ProseFont = "serif" | "sans";
export interface Settings { theme: Theme; codeFontSize: number; proseFont: ProseFont; wrap: boolean }

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ theme: "system", codeFontSize: 14, proseFont: "serif", wrap: true });

const THEMES = new Set<Theme>(["system", "dark", "light", "midnight"]);
/** pi-annotate's theme names. */
const LEGACY_THEMES: Record<string, Theme> = { slate: "dark", paper: "light" };

export class SettingsValidationError extends Error { statusCode = 400; }

const validFontSize = (value: unknown) => Number.isInteger(value) && (value as number) >= 10 && (value as number) <= 22;

/** UI preferences, shared by every host and independent of the server's port. */
export class SettingsStore {
  constructor(public readonly path: string, private legacyPath?: string) {}

  read(): Settings {
    const path = existsSync(this.path) ? this.path : this.legacyPath && existsSync(this.legacyPath) ? this.legacyPath : null;
    if (!path) return { ...DEFAULT_SETTINGS };
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      const value = saved?.settings ?? saved;
      const theme = LEGACY_THEMES[value?.theme] ?? value?.theme;
      return {
        theme: THEMES.has(theme) ? theme : DEFAULT_SETTINGS.theme,
        codeFontSize: validFontSize(value?.codeFontSize) ? value.codeFontSize : DEFAULT_SETTINGS.codeFontSize,
        proseFont: value?.proseFont === "sans" ? "sans" : "serif",
        wrap: value?.wrap !== false,
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  update(input: unknown): Settings {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsValidationError("Settings must be a JSON object");
    const patch = input as Record<string, unknown>;
    const next = this.read();
    if (Object.hasOwn(patch, "theme")) {
      if (!THEMES.has(patch.theme as Theme)) throw new SettingsValidationError("Invalid theme");
      next.theme = patch.theme as Theme;
    }
    if (Object.hasOwn(patch, "codeFontSize")) {
      if (!validFontSize(patch.codeFontSize)) throw new SettingsValidationError("Code font size must be an integer from 10 to 22");
      next.codeFontSize = patch.codeFontSize as number;
    }
    if (Object.hasOwn(patch, "proseFont")) {
      if (patch.proseFont !== "serif" && patch.proseFont !== "sans") throw new SettingsValidationError("Invalid prose font");
      next.proseFont = patch.proseFont;
    }
    if (Object.hasOwn(patch, "wrap")) {
      if (typeof patch.wrap !== "boolean") throw new SettingsValidationError("Wrap must be true or false");
      next.wrap = patch.wrap;
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + ".tmp", JSON.stringify({ schema: 1, settings: next }, null, 2) + "\n", { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
    return next;
  }
}
