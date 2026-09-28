import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from '../review.ts';
import { registerReview } from '../review-extension.ts';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'annotate-browse-')));
const project = join(sandbox, 'project'), output = join(sandbox, 'generated');
mkdirSync(project); mkdirSync(output);
try {
  const script = join(project, 'make-results.py');
  const result = join(output, 'results-summary.json');
  writeFileSync(script, 'print("hello")\n');
  writeFileSync(result, '{"score": 42}\n');
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, '.git', 'ignored-file'), 'secret');
  symlinkSync(output, join(project, 'escape'));
  const store = new ReviewStore(project, join(sandbox, 'store.json'), 'session');
  assert.deepEqual(store.browse(project).entries.map(e => e.name), ['make-results.py']);
  assert.deepEqual(store.search('rsm').results, []);
  assert.equal(store.search(output + '/').exact?.kind, 'folder');
  assert.equal(store.search(result).exact?.kind, 'file');
  assert.deepEqual(store.search(output + '/').results, []); // path is offered, not browsed yet
  assert.throws(() => store.browse(output), /Location not opened/);
  assert.throws(() => store.openBrowsableFile(result), /Location not opened/);
  assert.throws(() => store.openBrowsableFile(join(project, 'escape', 'results-summary.json')), /Location not opened/);
  const added = store.addLocation(output);
  assert.equal(added.directory, output);
  assert.equal(added.file, null);
  assert.ok(store.list().roots.every(root => !root.label.includes('external')));
  assert.equal(store.browse(output).entries[0].name, 'results-summary.json');
  assert.ok(store.search(output + '/').results.some(hit => hit.path === result));
  assert.ok(store.search(output + '/').results.every(hit => hit.path.startsWith(output + '/')));
  const hit = store.search('rsm').results[0];
  assert.equal(hit.path, result);
  assert.equal(hit.registered, false);
  assert.equal(store.openBrowsableFile(hit.path), result);
  assert.equal(store.document(result, 'session').plan, '{"score": 42}\n');
  assert.equal(store.document(result, 'session').patch, null);
  assert.equal(store.search('rsm').results[0].registered, true);
  const later = join(output, 'later-output.csv');
  writeFileSync(later, 'name,value\na,1\n');
  assert.ok(store.browse(output).entries.some(e => e.path === later));
  assert.equal(store.search('lout').results[0].path, later);
  assert.ok(new ReviewStore(project, join(sandbox, 'store.json'), 'session').list().roots.some(r => r.path === output));
  assert.equal(store.addLocation(result).file, result);
  assert.equal(store.addLocation('make-results.py').file, script);
  assert.throws(() => store.addLocation(join(output, 'missing')), /Path not found/);
  console.log('PASS project and explicit external roots, lazy browse, fuzzy search, persistence, symlink containment');

  // Exercise the authenticated HTTP routes through the real extension wiring.
  const hooks = new Map<string, Function>(); let url = '';
  const pi = { on: (event: string, fn: Function) => hooks.set(event, fn), exec: async (_: string, args: string[]) => { url = args.at(-1)!; return { code: 0 }; } };
  const open = registerReview(pi as any, join(sandbox, 'extension-state'));
  const ctx = { cwd: project, mode: 'tui', sessionManager: { getBranch: () => [], getSessionId: () => 'browse-test', getSessionFile: () => join(sandbox, 'session.jsonl') }, ui: { notify() {}, getEditorText: () => '', setEditorText() {} } };
  await hooks.get('session_start')!({}, ctx);
  try {
    await open(ctx as any);
    const html = await (await fetch(url)).text();
    assert.ok(html.includes('reviewBrowserTree')); // injected script builds the tree at runtime
    assert.ok(html.includes('Open exact path or folder'));
    const token = html.match(/"sessionToken":"([^"]+)"/)![1];
    const headers = { 'X-Annotation-Token': token, 'Content-Type': 'application/json' };
    const get = async (route: string) => fetch(url + route, { headers });
    const post = async (route: string, path: string) => fetch(url + route, { method: 'POST', headers, body: JSON.stringify({ path }) });
    assert.equal((await fetch(url + '/api/review/browse?path=' + encodeURIComponent(project))).status, 403);
    assert.equal((await get('/api/review/browse?path=' + encodeURIComponent(output))).status, 403);
    assert.equal((await post('/api/review/open-file', result)).status, 403);
    assert.equal((await post('/api/review/location', output)).status, 200);
    assert.equal((await get('/api/review/search?q=rsm')).status, 200);
    const found = await (await get('/api/review/search?q=rsm')).json() as any;
    assert.equal(found.results[0].path, result);
    const exact = await (await get('/api/review/search?q=' + encodeURIComponent(output + '/'))).json() as any;
    assert.equal(exact.exact.kind, 'folder');
    assert.equal(exact.exact.path, output);
    const opened = await (await post('/api/review/open-file', result)).json() as any;
    assert.equal(opened.path, result);
    const document = await (await get('/api/review/document?path=' + encodeURIComponent(result))).json() as any;
    assert.equal(document.patch, null);
    const list = await (await get('/api/review/list')).json() as any;
    assert.ok(list.roots.some((r: any) => r.path === output));
    assert.ok(list.files.some((f: any) => f.path === result && f.manual));
  } finally { hooks.get('session_shutdown')!(); }
  console.log('PASS authenticated browse, search, explicit location, open-file, no fabricated diff');
} finally { rmSync(sandbox, { recursive: true, force: true }); }
