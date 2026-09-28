import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDemoStore } from '../demo.ts';
import { registerDemo } from '../review-extension.ts';

const fixture = createDemoStore();
try {
  const files = fixture.store.list().files;
  assert.equal(files.filter(f => !f.manual).length, 6);
  assert.equal(files.filter(f => f.path.startsWith(fixture.shared)).length, 2);
  assert.ok(files.filter(f => f.path.startsWith(fixture.shared)).every(f => f.label.startsWith('/') && !f.label.includes('external')));
  assert.ok(files.some(f => f.path === fixture.script && f.latest));
  assert.match(fixture.store.document(fixture.report, 'request').patch!, /-Status: pending/);
  assert.throws(() => fixture.store.document(join(fixture.run, 'results.json'), 'request'), /not registered/);
  assert.ok(!fixture.store.list().files.some(f => f.path === join(fixture.run, 'results.json')));
  assert.ok(fixture.store.browse(fixture.run).entries.some(e => e.name === 'results.json'));
  assert.equal(fixture.store.search('rjson').results[0]?.path, join(fixture.run, 'results.json'));
  assert.equal(fixture.store.document(fixture.context, 'request').patch, null);
  assert.ok(fixture.store.list().roots.every(root => !root.label.includes('external')));
  console.log('PASS deterministic isolated fixture: grouped edits, prior request, uncaptured outputs, opened-only file');
} finally { rmSync(fixture.directory, { recursive: true, force: true }); }

const hooks = new Map<string, Function>(); const urls: string[] = [];
let editor = 'existing Pi draft';
const pi = { on: (event: string, fn: Function) => hooks.set(event, fn), exec: async (_: string, args: string[]) => { urls.push(args.at(-1)!); return { code: 0 }; } };
const open = registerDemo(pi as any);
const ctx = { mode: 'tui', ui: { notify() {}, getEditorText: () => editor, setEditorText: (text: string) => { editor = text; } } };
try {
  await open(ctx as any);
  assert.equal(urls.length, 1);
  const html = await (await fetch(urls[0])).text();
  assert.match(html, /reviewDemoNotice/);
  const token = html.match(/"sessionToken":"([^"]+)"/)![1];
  const headers = { 'X-Annotation-Token': token, 'Content-Type': 'application/json' };
  const list = await (await fetch(urls[0] + '/api/review/list', { headers })).json() as any;
  assert.equal(list.demo, true);
  assert.equal(list.targetFolder, list.roots[0].path);
  assert.ok(list.files.some((f: any) => f.path === list.target && !f.manual));
  const script = await (await fetch(urls[0] + '/api/review/document?path=' + encodeURIComponent(list.target), { headers })).json() as any;
  const annotation = { id: 'demo-1', type: 'comment', text: 'A reproducible note', originalText: 'from', selectedText: 'from', range: { startOffset: 0, endOffset: 4, textPreview: 'from' }, createdAt: Date.now() };
  const saved = await fetch(urls[0] + '/api/review/draft', { method: 'POST', headers, body: JSON.stringify({ path: list.target, markdown: script.plan, annotations: [annotation] }) });
  assert.equal(saved.status, 200);
  const done = await (await fetch(urls[0] + '/api/review/done', { method: 'POST', headers, body: '{}' })).json() as any;
  assert.equal(done.demo, true);
  assert.match(done.feedback, /A reproducible note/);
  assert.equal(editor, 'existing Pi draft');
  const firstDirectory = dirname(list.roots[0].path);
  await open(ctx as any, true);
  assert.equal(urls.length, 2);
  assert.equal(existsSync(firstDirectory), false);
  const token2 = (await (await fetch(urls[1])).text()).match(/"sessionToken":"([^"]+)"/)![1];
  const next = await (await fetch(urls[1] + '/api/review/list', { headers: { 'X-Annotation-Token': token2 } })).json() as any;
  assert.equal(next.files.find((f: any) => f.path === next.target).notes, 0);
  console.log('PASS demo command, isolated feedback preview, reset, Pi editor untouched');
} finally { hooks.get('session_shutdown')!(); }
