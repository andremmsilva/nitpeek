import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsStore } from "../core/settings.ts";
import { sandbox, suite } from "./helpers.ts";

suite("settings: defaults, legacy import, validation, permissions", () => {
  const box = sandbox("settings");
  try {
    const legacy = join(box.directory, "legacy.json");
    const store = new SettingsStore(join(box.directory, "settings.json"), legacy);
    assert.deepEqual(store.read(), { theme: "system", codeFontSize: 14, proseFont: "serif", wrap: true });
    writeFileSync(legacy, JSON.stringify({ schema: 1, settings: { theme: "paper", codeFontSize: 16 } }));
    assert.deepEqual(store.read(), { theme: "light", codeFontSize: 16, proseFont: "serif", wrap: true }, "pi-annotate settings carry over");
    assert.throws(() => store.update({ theme: "neon" }), /Invalid theme/);
    assert.throws(() => store.update({ codeFontSize: 40 }), /10 to 22/);
    assert.throws(() => store.update([]), /JSON object/);
    assert.deepEqual(store.update({ theme: "midnight", proseFont: "sans" }), { theme: "midnight", codeFontSize: 16, proseFont: "sans", wrap: true });
    assert.equal(store.update({ wrap: false }).wrap, false);
    assert.throws(() => store.update({ wrap: "no" }), /true or false/);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(new SettingsStore(store.path).read().theme, "midnight");
  } finally { box.cleanup(); }
});
