import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual injected breadcrumb functions with a small DOM facade;
// no browser dependency or changes to the existing test harness are needed.
const source = readFileSync(new URL('../form/review.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  async function showDirectory('), source.indexOf('  function closePalette()'));
assert.ok(section.startsWith('  async function showDirectory('));
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  className = ''; textContent = ''; title = ''; hidden = false; onclick?: () => Promise<void>;
  attributes: Record<string, string> = {};
  constructor(public tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  querySelectorAll(selector: string): Element[] {
    return selector === '[data-review-path]' ? this.children.filter(c => c.dataset.reviewPath) : [];
  }
  scrollIntoView() { this.attributes.scrolled = 'yes'; }
}
const calls: string[] = [];
const crumb = new Element('nav');
const browser = new Element('div');
const status = new Element('div');
let current: any = null;
const context = {
  document: { createElement: (tag: string) => new Element(tag) },
  navigator: { clipboard: { writeText: async (path: string) => { calls.push('copy:' + path); } } },
  breadcrumb: crumb, browserTree: browser, status,
  get current() { return current; },
  busy: false,
  editing: () => false,
  postJson: async (url: string, body: { path: string }) => {
    calls.push(url + ':' + body.path);
    return { directory: body.path };
  },
  expanded: new Set<string>(),
  refresh: async () => { calls.push('refresh'); },
  loadFolder: async (path: string, force: boolean) => { calls.push('load:' + path + ':' + force); },
  report: (error: Error) => { throw error; },
};
const { drawBreadcrumb } = runInNewContext('let crumbsExpanded = false;\n' + section + '\n({ drawBreadcrumb })', context) as { drawBreadcrumb: () => void };
const buttons = (node: Element): Element[] => node.children.flatMap(child => [child, ...buttons(child)]).filter(child => child.tag === 'button');
const click = async (name: string) => {
  const button = buttons(crumb).find(b => b.textContent === name);
  assert.ok(button, 'missing ' + name);
  await button.onclick!();
  await new Promise(resolve => setTimeout(resolve, 0));
};

current = { path: '/tmp/run-42/results.json', kind: 'file', annotations: [{ text: 'keep' }] };
drawBreadcrumb();
assert.equal(crumb.title, current.path);
assert.equal(crumb.attributes['aria-label'], 'Document path: ' + current.path);
assert.deepEqual(buttons(crumb).slice(0, 3).map(b => b.title), ['/', '/tmp', '/tmp/run-42']);
assert.equal(crumb.children.find(e => e.className === 'review-crumb-file')?.textContent, 'results.json');
await click('tmp');
assert.deepEqual(calls, ['/api/review/location:/tmp', 'refresh', 'load:/tmp:true']);
assert.equal(current.path, '/tmp/run-42/results.json');
assert.equal(current.annotations.length, 1);
assert.ok(context.expanded.has('/tmp'));
calls.length = 0;
const target = new Element('button'); target.dataset.reviewPath = current.path; browser.append(target);
await click('Reveal in tree');
assert.deepEqual(calls, ['/api/review/location:/tmp/run-42', 'refresh', 'load:/tmp/run-42:true']);
assert.equal(target.attributes.scrolled, 'yes');
calls.length = 0;
await click('Pin folder');
assert.equal(calls[0], '/api/review/location:/tmp/run-42');
assert.equal(current.path, '/tmp/run-42/results.json');
calls.length = 0;
await click('Copy path');
assert.deepEqual(calls, ['copy:/tmp/run-42/results.json']);
current = { path: '/private/var/folders/demo/workspace/runs/exp-01/results.json', kind: 'file' };
drawBreadcrumb();
assert.ok(buttons(crumb).some(b => b.textContent === '…'));
assert.ok(!buttons(crumb).some(b => b.title === '/private/var'));
await click('…');
assert.ok(buttons(crumb).some(b => b.title === '/private/var'));
current = { path: 'reports/out.csv', kind: 'file' };
drawBreadcrumb();
assert.deepEqual(buttons(crumb).slice(0, 1).map(b => b.title), ['reports']);
await click('reports');
assert.equal(calls.at(-3), '/api/review/location:reports');
current = { path: 'message:abc', kind: 'response' };
drawBreadcrumb();
assert.equal(crumb.textContent, '');
assert.equal(crumb.children[0]?.textContent, 'Agent response');
assert.equal(buttons(crumb).length, 0);
current = null; drawBreadcrumb();
assert.equal(crumb.hidden, true);
console.log('PASS document breadcrumbs, explicit folder actions, copy/reveal, relative paths and response');
