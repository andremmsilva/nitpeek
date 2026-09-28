import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AnnotateTheme = "system" | "slate" | "paper" | "midnight";
export interface AnnotateSettings {
  theme: AnnotateTheme;
  codeFontSize: number;
}

export const DEFAULT_ANNOTATE_SETTINGS: Readonly<AnnotateSettings> = Object.freeze({
  theme: "system",
  codeFontSize: 14,
});

const THEMES = new Set<AnnotateTheme>(["system", "slate", "paper", "midnight"]);

export class SettingsValidationError extends Error {
  statusCode = 400;
}

/** Shared UI preferences, independent of the short-lived browser/server port. */
export class AnnotateSettingsStore {
  constructor(public readonly path: string) {}

  isInitialized(): boolean {
    return existsSync(this.path);
  }

  read(): AnnotateSettings {
    if (!existsSync(this.path)) return { ...DEFAULT_ANNOTATE_SETTINGS };
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8"));
      const value = saved?.schema === 1 ? saved.settings : saved;
      return {
        theme: THEMES.has(value?.theme) ? value.theme : DEFAULT_ANNOTATE_SETTINGS.theme,
        codeFontSize: Number.isInteger(value?.codeFontSize) && value.codeFontSize >= 10 && value.codeFontSize <= 22
          ? value.codeFontSize
          : DEFAULT_ANNOTATE_SETTINGS.codeFontSize,
      };
    } catch {
      return { ...DEFAULT_ANNOTATE_SETTINGS };
    }
  }

  update(input: unknown): AnnotateSettings {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SettingsValidationError("Settings must be a JSON object");
    }
    const patch = input as Record<string, unknown>;
    const next = this.read();
    if (Object.hasOwn(patch, "theme")) {
      if (typeof patch.theme !== "string" || !THEMES.has(patch.theme as AnnotateTheme)) {
        throw new SettingsValidationError("Invalid theme");
      }
      next.theme = patch.theme as AnnotateTheme;
    }
    if (Object.hasOwn(patch, "codeFontSize")) {
      if (!Number.isInteger(patch.codeFontSize) || (patch.codeFontSize as number) < 10 || (patch.codeFontSize as number) > 22) {
        throw new SettingsValidationError("Code font size must be an integer from 10 to 22");
      }
      next.codeFontSize = patch.codeFontSize as number;
    }

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + ".tmp";
    writeFileSync(temporary, JSON.stringify({ schema: 1, settings: next }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.path);
    return next;
  }
}
