import assert from "node:assert/strict";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
process.env.NITPEEK_HOME ||= "/tmp/nitpeek-test-home";
const { startWorkspace } = await import("../core/workspace.ts");
const { inlineJson, isLoopbackHost } = await import("../core/server.ts");
const { sandbox, suite } = await import("./helpers.ts");

function raw(url: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url + path, { headers }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end();
  });
}

suite("server: loopback, token, framing, routes, Done", async () => {
  const box = sandbox("server");
  const delivered: string[] = [];
  const store = box.store();
  const path = join(box.directory, "a.txt");
  writeFileSync(path, "one\n");
  store.nextRequest("edit a");
  store.begin("x", path); writeFileSync(path, "one\ntwo\n"); store.end("x", false);
  const workspace = await startWorkspace(store, { name: "Test", deliveryNote: () => "into the test", deliver: async text => { delivered.push(text); return "delivered"; } });
  try {
    const page = await fetch(workspace.url);
    const html = await page.text();
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const token = JSON.parse(html.match(/<script id="nitpeek-data" type="application\/json">(.*?)<\/script>/)![1]).token;
    assert.ok(token);
    assert.equal((await fetch(workspace.url + "/app.js")).status, 200);
    assert.equal((await fetch(workspace.url + "/api/review/overview")).status, 403, "token required");
    assert.equal(await raw(workspace.url, "/", { Host: "evil.example:80" }), 403, "DNS rebinding rejected");
    const headers = { "X-Nitpeek-Token": token, "Content-Type": "application/json" };
    const get = (route: string) => fetch(workspace.url + route, { headers }).then(r => r.json());
    const post = (route: string, body: unknown) => fetch(workspace.url + route, { method: "POST", headers, body: JSON.stringify(body) });

    assert.equal(workspace.isOpen(), false);
    const overview = await get("/api/review/overview");
    assert.equal(workspace.isOpen(), true);
    assert.equal(overview.host, "Test");
    assert.equal(overview.requests[0].files[0].path, path);
    const doc = await get("/api/review/document?path=" + encodeURIComponent(path) + "&scope=since");
    assert.equal(doc.diff.added, 1);
    assert.deepEqual(await get("/api/review/stat?path=" + encodeURIComponent(path)), { ref: doc.ref });
    assert.equal((await post("/api/review/notes", { path, notes: [{ id: "bad!" }] })).status, 400);
    assert.equal((await post("/api/review/notes", { path, notes: [{ id: "n1", intent: "ask", text: "Why two?", quote: "two", source: "two", start: 4, end: 7, view: "document", ref: doc.ref, createdAt: 1 }] })).status, 200);
    const preview = await get("/api/review/preview");
    assert.equal(preview.deliveryNote, "into the test");
    assert.match(preview.feedback, /\[1\] ask · a\.txt:2/);
    const done = await (await post("/api/review/done", {})).json();
    assert.equal(done.message, "delivered");
    assert.match(delivered[0], /Why two\?/);
    const after = await get("/api/review/overview");
    assert.equal(after.notes, 0);
    assert.ok(after.checkpoint);
    assert.equal(after.since.files.length, 0);
    workspace.focus({ path });
    assert.equal((await get("/api/review/overview")).target.path, path);
    assert.equal((await fetch(workspace.url + "/api/review/nope", { headers })).status, 404);
    assert.equal((await post("/api/review/closed", {})).status, 200);
    assert.equal(workspace.isOpen(), false);
  } finally { workspace.stop(); box.cleanup(); }
  assert.equal(isLoopbackHost("127.0.0.1:1234"), true);
  assert.equal(isLoopbackHost("[::1]:80"), true);
  assert.equal(isLoopbackHost("localhost.evil.com"), false);
  assert.doesNotMatch(inlineJson({ x: "</script><script>alert(1)</script>" }), /<\/script>/);
});
