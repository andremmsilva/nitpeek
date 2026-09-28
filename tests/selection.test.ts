import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from '../review.ts';
import { handleAnnotationDecision } from '../index.ts';

const html = readFileSync(new URL('../form/annotate.html', import.meta.url), 'utf8');
const helpers = html.slice(html.indexOf('  function findTextInBlockRange'), html.indexOf('  /* ===== Floating Toolbar'));
const add = html.slice(html.indexOf('  function addAnnotation'), html.indexOf('  function sortAnnotations'));
const directory = mkdtempSync(join(tmpdir(), 'annotate-selection-'));
try {
  for (const [md, selected] of [
    ['Antes: só diria *occurrence* quando fosse preciso sublinhar que duas invocações do mesmo `step` são distintas. Depois.', 'só diria occurrence quando fosse preciso sublinhar que duas invocações do mesmo step são distintas'],
    ['- Each total order defines a workload', 'total order'],
    ['Before **bold** and [link](https://example.com) after', 'bold and link'],
    ['Before first\nsecond after', 'first\nsecond'],
  ]) {
    const block = { nodeType: 1, classList: { contains: () => true }, dataset: { offsetStart: '0', offsetEnd: String(md.length) } };
    const range = { startContainer: block, endContainer: block, startOffset: 0, getBoundingClientRect: () => ({}) };
    const window = { getSelection: () => ({ isCollapsed: false, toString: () => selected, getRangeAt: () => range }) };
    const document = { createRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => '' }) };
    const annotation = new Function('window', 'document', 'planData', `
      const annotations = [];
      function generateId() { return 'test'; }
      function sortAnnotations() {}
      function updateAll() {}
      function showFloatingToolbar() {}
      ${helpers}\n${add}
      handleTextSelection();
      return addAnnotation('comment', 'se mais concreto, nao entendi', pendingRange);
    `)(window, document, { plan: md });
    assert.equal(annotation.selectedText, selected);
    assert.equal(annotation.originalText, selected); // not the 80-character preview
    const store = new ReviewStore(directory, join(directory, 'state.json'), 'test');
    const path = store.response('response-' + md.length, md)!;
    store.draft({ path, markdown: md, annotations: [annotation] });
    const quote = selected.split('\n').map(line => '> ' + line).join('\n');
    assert.ok(store.feedback().includes(quote + '\n'));
    const restored = new ReviewStore(directory, join(directory, 'state.json'), 'test');
    assert.equal(restored.state.drafts[path].annotations[0].selectedText, selected);
    let editor = '';
    handleAnnotationDecision({} as any, { hasUI: true, ui: { getEditorText: () => '', setEditorText: (s: string) => { editor = s; }, notify() {} } } as any,
      { action: 'feedback', annotations: [annotation] }, 'response', md, 'annotate-last');
    assert.ok(editor.includes(quote + '\n'));
    assert.ok(!editor.includes('> ' + md));
    store.clearDrafts();
  }
  console.log('SELECTION SUITE PASSED: browser capture → persistence → both feedback paths');
} finally { rmSync(directory, { recursive: true, force: true }); }
