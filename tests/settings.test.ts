import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotationServer } from "../server.ts";
import { AnnotateSettingsStore, DEFAULT_ANNOTATE_SETTINGS } from "../settings.ts";

const directory = mkdtempSync(join(tmpdir(), "annotate-settings-"));
const path = join(directory, "settings.json");
const settings = new AnnotateSettingsStore(path);
let server: Awaited<ReturnType<typeof startAnnotationServer>> | undefined;
try {
  assert.deepEqual(settings.read(), DEFAULT_ANNOTATE_SETTINGS);
  assert.equal(settings.isInitialized(), false);

  server = await startAnnotationServer({
    markdown: "", renderedHtml: "", htmlContent: "<script>JSON.parse('__ANNOTATE_DATA__')</script>",
    mode: "annotate", settings,
  });
  const page = await (await fetch(server.url)).text();
  const literal = page.match(/JSON\.parse\('((?:\\.|[^'\\])*)'\)/)?.[1];
  assert.ok(literal);
  const inline = JSON.parse(new Function(`return '${literal}'`)() as string) as any;
  assert.deepEqual(inline.settings, { theme: "system", codeFontSize: 14 });
  assert.equal(inline.settingsInitialized, false);

  assert.equal((await fetch(server.url + "/api/settings")).status, 403);
  const headers = { "X-Annotation-Token": inline.sessionToken, "Content-Type": "application/json" };
  const post = (patch: unknown) => fetch(server!.url + "/api/settings", { method: "POST", headers, body: JSON.stringify(patch) });
  const saved = await (await post({ theme: "paper", codeFontSize: 19 })).json();
  assert.deepEqual(saved, { theme: "paper", codeFontSize: 19 });
  assert.equal((await post({ theme: "neon" })).status, 400);
  assert.deepEqual(await (await fetch(server.url + "/api/settings", { headers })).json(), saved);

  const freshStore = new AnnotateSettingsStore(path);
  assert.equal(freshStore.isInitialized(), true);
  assert.deepEqual(freshStore.read(), saved);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: 1, settings: saved });
  assert.deepEqual(freshStore.update({ theme: "system" }), { theme: "system", codeFontSize: 19 });
  console.log("PASS persistent settings defaults, validation, authenticated API, permissions and reload");
} finally {
  server?.stop();
  rmSync(directory, { recursive: true, force: true });
}
