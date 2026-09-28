import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../form/review.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  async function loadFolder('), source.indexOf('  async function openBrowsable('));
assert.ok(section.startsWith('  async function loadFolder('));

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  className = ''; textContent = ''; title = ''; open = false; type = '';
  onclick?: (event: { preventDefault(): void; stopPropagation(): void }) => void;
  constructor(public tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, handler: () => void) { this.listeners[name] = handler; }
}

const directory = (name: string, path: string) => ({ name, path, directory: true });
const file = (name: string, path: string) => ({ name, path, directory: false });
const contents = new Map<string, { entries: ReturnType<typeof directory>[] | any[] }>([
  ['/project', { entries: [directory('src', '/project/src'), directory('docs', '/project/docs')] }],
  ['/project/src', { entries: [directory('main', '/project/src/main')] }],
  ['/project/src/main', { entries: [directory('java', '/project/src/main/java')] }],
  ['/project/src/main/java', { entries: [directory('pt', '/project/src/main/java/pt')] }],
  ['/project/src/main/java/pt', { entries: [directory('ulisboa', '/project/src/main/java/pt/ulisboa')] }],
  ['/project/src/main/java/pt/ulisboa', { entries: [directory('tecnico', '/project/src/main/java/pt/ulisboa/tecnico')] }],
  ['/project/src/main/java/pt/ulisboa/tecnico', { entries: [directory('socialsoftware', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware')] }],
  ['/project/src/main/java/pt/ulisboa/tecnico/socialsoftware', { entries: [directory('ms', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms')] }],
  ['/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms', { entries: [directory('verifiers', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers')] }],
  ['/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers', { entries: [directory('faults', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers/faults')] }],
  ['/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers/faults', { entries: [directory('buildingblock', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers/faults/buildingblock'), directory('copiedupdate', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers/faults/copiedupdate'), file('Fault.java', '/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers/faults/Fault.java')] }],
  ['/project/docs', { entries: [file('guide.md', '/project/docs/guide.md')] }],
]);
const calls: string[] = [];
const browserTree = new Element('div');
const expanded = new Set(['/project']);
const context = {
  document: { createElement: (tag: string) => new Element(tag) },
  listing: { roots: [{ path: '/project', label: 'Project' }] },
  browserTree, expanded, folders: new Map(), loading: new Set(), current: null,
  get: async (url: string) => {
    const path = decodeURIComponent(url.slice(url.indexOf('path=') + 5));
    calls.push(path);
    const result = contents.get(path);
    if (!result) throw new Error('Missing test folder ' + path);
    return result;
  },
  openBrowsable: async () => {}, report: (error: Error) => { throw error; },
};
const { drawBrowser } = runInNewContext(section + '\n({ drawBrowser })', context) as { drawBrowser: () => void };
const walk = (node: Element): Element[] => [node, ...node.children.flatMap(walk)];
const findFolder = (label: string) => walk(browserTree).find(node => node.tag === 'details' && node.children[0]?.children[0]?.textContent === label);
const settle = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(condition(), 'timed out waiting for browser tree');
};

drawBrowser();
await settle(() => findFolder('Project')?.children.length === 3);
assert.ok(!calls.includes('/project/src'), 'closed siblings should remain lazy');

let src = findFolder('src');
assert.ok(src);
src.open = true; src.listeners.toggle();
const compactLabel = 'src.main.java.pt.ulisboa.tecnico.socialsoftware.ms.verifiers.faults';
await settle(() => !!findFolder(compactLabel));
assert.ok(!calls.includes('/project/docs'), 'unopened sibling folders should not be scanned');
const compact = findFolder(compactLabel)!;
assert.equal(compact.open, true);
assert.ok(compact.children.some(child => child.textContent === 'Fault.java'));
assert.ok(findFolder('buildingblock'));
assert.ok(findFolder('copiedupdate'));

const refresh = compact.children[0].children[1];
assert.equal(refresh.textContent, '↻');
calls.length = 0;
refresh.onclick!({ preventDefault() {}, stopPropagation() {} });
await settle(() => calls.includes('/project/src/main/java/pt/ulisboa/tecnico/socialsoftware/ms/verifiers/faults'));
assert.ok(calls.length > 1, 'refreshing a compact path refreshes all folders in the chain');

compact.open = false; compact.listeners.toggle();
assert.ok(!expanded.has('/project/src'));
assert.equal(compact.open, false, 'the compact package path stays visible while collapsed');
console.log('PASS compact single-child folder chains, branching, lazy siblings and refresh');
