// Injected into the existing annotation UI closure only for session review.
review = ANNOTATE_DATA.workspace ? (() => {
  let current = null, listing = { files: [] }, scope = 'request', view = 'document';
  let ready = false, busy = false, writes = Promise.resolve(), saveError = null, focusSeen = 0, saveSequence = 0;
  let nav, tree, responseTree, browserTree, status, warning, patch, total, scopeSelect, palette, searchInput, searchResults, breadcrumb, documentHeader, sourceButton, wrapButton, diffButton, sourceBadge;
  let sourceView = false, wordWrap = true, lineObserver = null, lineFrame = 0, crumbsExpanded = false, searchHits = [], shownHits = [], searchPosition = 0, searchTimer, searchSequence = 0, lastFolderScan = 0, paletteReturnFocus = null;
  const expanded = new Set(), folders = new Map(), loading = new Set(), recentFiles = [], pendingLineFrames = new Set();
  const $ = id => document.getElementById(id);
  function entries() {
    const items = [...(listing.responses || []), ...listing.files];
    if (current && !items.some(f => f.path === current.path)) items.unshift({ path: current.path, label: current.kind === 'response' ? '💬 Earlier response · open' : current.sourceInfo, notes: annotations.length, newest: false, latest: false });
    return items;
  }
  function visibleEntries() {
    return entries().filter(f => scope === 'session' || f.latest || f.manual || f.notes > 0 || f.path === current?.path);
  }
  async function get(url) {
    const response = await fetch(url, { headers: AUTH_HEADERS });
    if (!response.ok) throw new Error((await response.json()).error || 'Disconnected');
    return response.json();
  }
  function payload() { return current ? { path: current.path, markdown: planData.plan, annotations: JSON.parse(JSON.stringify(annotations)) } : null; }
  function saveStatus(text, failed = false) {
    status.replaceChildren();
    const label = document.createElement('span'); label.textContent = text; status.append(label);
    if (failed) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry save';
      retry.onclick = changed; status.append(' ', retry);
    }
    const footer = $('reviewDraftStatus');
    if (footer) footer.textContent = text;
  }
  function changed() {
    const frame = $('content').querySelector('.review-code-frame');
    if (frame) scheduleLineNumbers(frame);
    if (!ready || !current) return;
    const data = payload(), sequence = ++saveSequence;
    saveStatus('Saving locally…');
    // Serialize writes: a slow older save must never replace a newer draft.
    writes = writes.catch(() => {}).then(() => postJson('/api/review/draft', data)).then(() => {
      saveError = null;
      if (sequence === saveSequence) saveStatus('Saved locally · not sent');
      const file = entries().find(f => f.path === data.path);
      if (file) file.notes = data.annotations.length;
      drawTree();
    }).catch(error => {
      saveError = error;
      if (sequence === saveSequence) saveStatus('Could not save — ' + error.message, true);
    });
  }
  async function flush() { await writes; if (saveError) { changed(); await writes; if (saveError) throw saveError; } }
  function host() { return listing?.host || 'Pi'; }
  function buttons() {
    if (!total) return;
    const count = entries().reduce((sum, f) => sum + (current?.path === f.path ? annotations.length : f.notes), 0);
    total.textContent = count + (count === 1 ? ' note' : ' notes') + ' across responses and files';
    $('annCount').textContent = String(count);
    $('reviewAnnotationLabel').textContent = count === 1 ? 'review note' : 'review notes';
    const footer = $('reviewDraftStatus');
    if (footer && !saveError && !footer.textContent.includes('Saving')) footer.textContent = count + (count === 1 ? ' note' : ' notes') + ' · saved locally · not sent';
    if (scopeSelect) scopeSelect.disabled = busy;
    $('btnFeedback').disabled = busy || count === 0;
    $('btnFeedback').textContent = listing.demo ? 'Preview fixture feedback' : `Done → ${host()} draft`;
  }
  function fileGroups(container, files) {
    const previous = new Map(Array.from(container.querySelectorAll('details')).map(d => [d.dataset.directory, d.open]));
    container.replaceChildren();
    const directories = new Map([['', container]]);
    for (const file of files.sort((a, b) => a.label.localeCompare(b.label))) {
      // Outside the Pi cwd, group by the real parent directory. "External"
      // described the cwd boundary, not whether the file was agent-made.
      const absolute = file.label.startsWith('/');
      const slash = file.label.lastIndexOf('/');
      const parts = absolute ? [file.label.slice(0, slash), file.label.slice(slash + 1)] : file.label.split('/');
      let parent = container, prefix = '';
      for (const part of parts.slice(0, -1)) {
        prefix += part + '/';
        const key = (absolute ? 'absolute:' : 'project:') + prefix;
        if (!directories.has(key)) {
          const directory = document.createElement('details');
          directory.dataset.directory = key;
          directory.open = previous.get(key) ?? true;
          const summary = document.createElement('summary');
          summary.textContent = absolute ? part.split('/').filter(Boolean).slice(-2).join('/') : part;
          summary.title = absolute ? part : file.path;
          directory.append(summary); parent.append(directory); directories.set(key, directory);
        }
        parent = directories.get(key);
      }
      const button = document.createElement('button');
      button.textContent = (file.manual ? '◦ ' : '● ') + parts.at(-1) + (file.notes ? ' · ' + file.notes : '') + (file.error ? ' ⚠' : '');
      button.title = (file.manual ? 'Opened for review · no recorded before-version' : 'Captured change') + ' · ' + file.path;
      button.className = 'review-file' + (current?.path === file.path ? ' selected' : '');
      button.onclick = () => open(file.path).catch(report);
      parent.append(button);
    }
  }
  function drawTree() {
    if (!tree) return;
    const visible = visibleEntries();
    responseTree.replaceChildren();
    for (const response of visible.filter(f => f.path.startsWith('message:')).reverse()) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'review-file' + (current?.path === response.path ? ' selected' : '');
      button.textContent = response.label + (response.notes ? ' · ' + response.notes : '');
      button.onclick = () => open(response.path).catch(report);
      responseTree.append(button);
    }
    if (!responseTree.childElementCount) responseTree.textContent = 'No response in this scope.';
    // One file tree, regardless of whether Pi captured an edit or a user opened it.
    // The row title conveys provenance; discovery alone never creates a diff.
    const files = visible.filter(f => !f.path.startsWith('message:'));
    fileGroups(tree, files);
    if (!tree.childElementCount) tree.textContent = 'No captured edits yet. Find a file or open a folder to review.';
    buttons();
  }
  async function loadFolder(path, force = false) {
    if (loading.has(path) || (!force && folders.has(path))) return;
    loading.add(path);
    try { folders.set(path, await get('/api/review/browse?path=' + encodeURIComponent(path))); }
    catch (error) { folders.set(path, { entries: [], error: error.message }); }
    finally { loading.delete(path); drawBrowser(); }
  }
  function folderNode(path, label) {
    // IntelliJ-style compact packages: when an expanded folder contains only
    // one subfolder, follow that chain until it reaches files or a branch.
    // Closed sibling folders stay lazy; we only scan down the path the user opened.
    const chain = [{ path, label }];
    if (expanded.has(path)) {
      while (true) {
        const contents = folders.get(chain.at(-1).path);
        if (!contents) { loadFolder(chain.at(-1).path); break; }
        if (contents.error || contents.entries.length !== 1 || !contents.entries[0].directory) break;
        const child = contents.entries[0];
        if (chain.some(folder => folder.path === child.path)) break;
        chain.push({ path: child.path, label: child.name });
        if (!folders.has(child.path)) { loadFolder(child.path); break; }
      }
    }
    const terminal = chain.at(-1);
    const details = document.createElement('details'); details.open = expanded.has(path);
    const summary = document.createElement('summary'); summary.title = chain.map(folder => folder.path).join(' / ');
    const name = document.createElement('span'); name.textContent = chain.map(folder => folder.label).join('.'); summary.append(name);
    const refreshButton = document.createElement('button'); refreshButton.type = 'button';
    refreshButton.className = 'review-folder-refresh'; refreshButton.textContent = '↻';
    refreshButton.title = 'Refresh folder path · ' + summary.title; refreshButton.setAttribute('aria-label', 'Refresh folder path ' + summary.title);
    refreshButton.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      Promise.all(chain.map(folder => loadFolder(folder.path, true))).catch(report);
    };
    summary.append(refreshButton); details.append(summary);
    details.addEventListener('toggle', () => {
      if (details.open) { expanded.add(path); loadFolder(terminal.path); }
      else expanded.delete(path);
    });
    if (details.open) {
      const contents = folders.get(terminal.path);
      if (contents?.error) { const note = document.createElement('p'); note.textContent = contents.error; details.append(note); }
      else if (!contents) { const note = document.createElement('p'); note.textContent = 'Loading…'; details.append(note); loadFolder(terminal.path); }
      else {
        for (const entry of contents.entries) {
          if (entry.directory) details.append(folderNode(entry.path, entry.name));
          else {
            const button = document.createElement('button'); button.className = 'review-file' + (current?.path === entry.path ? ' selected' : '');
            button.textContent = entry.name; button.title = entry.path;
            button.dataset.reviewPath = entry.path;
            button.onclick = () => openBrowsable(entry.path).catch(report);
            details.append(button);
          }
        }
        if (contents.truncated) { const note = document.createElement('p'); note.textContent = 'First 500 entries shown. Narrow the search or open a deeper folder.'; details.append(note); }
        if (!contents.entries.length) { const note = document.createElement('p'); note.textContent = 'Empty folder'; details.append(note); }
      }
    }
    return details;
  }
  function drawBrowser() {
    if (!browserTree) return;
    browserTree.replaceChildren();
    for (const root of listing.roots || []) browserTree.append(folderNode(root.path, root.label));
  }
  async function openBrowsable(path) {
    if (busy || editing()) return;
    const result = await postJson('/api/review/open-file', { path });
    await refresh();
    await open(result.path);
    closePalette();
  }
  async function addLocation(path) {
    if (busy || editing()) return;
    const result = await postJson('/api/review/location', { path });
    expanded.add(result.directory);
    await refresh();
    loadFolder(result.directory, true);
    if (result.file) await open(result.file);
    closePalette();
  }
  // Opening a breadcrumb directory is always a deliberate location request.
  // It does not select a new document or touch its draft/notes.
  async function showDirectory(path, revealFile) {
    if (busy || editing()) return;
    const result = await postJson('/api/review/location', { path });
    expanded.add(result.directory);
    await refresh();
    await loadFolder(result.directory, true);
    if (revealFile) {
      const button = [...browserTree.querySelectorAll('[data-review-path]')].find(node => node.dataset.reviewPath === revealFile);
      button?.scrollIntoView({ block: 'nearest' });
      if (!button) status.textContent = 'Folder opened. File may be outside the first 500 entries.';
    }
  }
  function drawBreadcrumb() {
    breadcrumb.replaceChildren();
    if (!current) { breadcrumb.hidden = true; return; }
    breadcrumb.hidden = false;
    const path = current.path;
    breadcrumb.title = current.kind === 'response' ? 'Agent response' : path;
    breadcrumb.setAttribute('aria-label', current.kind === 'response' ? 'Agent response' : 'Document path: ' + path);
    if (current.kind === 'response') {
      const label = document.createElement('span'); label.textContent = 'Agent response';
      breadcrumb.append(label); return;
    }
    const absolute = path.startsWith('/');
    const parts = path.split('/').filter(Boolean);
    const directories = absolute ? ['/'] : [];
    for (let i = 0; i < parts.length - 1; i++) {
      directories.push((absolute ? '/' : '') + parts.slice(0, i + 1).join('/'));
    }
    const collapsed = !crumbsExpanded && directories.length > 5;
    const shown = collapsed ? [directories[0], ...directories.slice(-3)] : directories;
    const separator = () => {
      const slash = document.createElement('span'); slash.className = 'review-crumb-separator';
      slash.textContent = '/'; slash.setAttribute('aria-hidden', 'true'); breadcrumb.append(slash);
    };
    for (const [index, directory] of shown.entries()) {
      if (index && shown[index - 1] !== '/') separator();
      if (collapsed && index === 1) {
        const more = document.createElement('button'); more.type = 'button'; more.textContent = '…';
        more.title = 'Show all parent folders'; more.setAttribute('aria-label', 'Show all parent folders');
        more.onclick = () => { crumbsExpanded = true; drawBreadcrumb(); };
        breadcrumb.append(more); separator();
      }
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = directory === '/' ? '/' : directory.split('/').at(-1);
      button.title = directory;
      button.setAttribute('aria-label', 'Open folder ' + directory);
      button.onclick = () => showDirectory(directory).catch(report);
      breadcrumb.append(button);
    }
    if (shown.length && shown.at(-1) !== '/') separator();
    const file = document.createElement('span'); file.className = 'review-crumb-file';
    file.textContent = parts.at(-1) || path; file.title = path;
    breadcrumb.append(file);
    const actions = document.createElement('span'); actions.className = 'review-crumb-actions';
    const action = (label, handler) => {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = label; button.title = label + ' · ' + path;
      button.setAttribute('aria-label', label + ': ' + path);
      button.onclick = () => Promise.resolve().then(handler).catch(report);
      actions.append(button);
    };
    const parent = absolute ? '/' + parts.slice(0, -1).join('/') : parts.slice(0, -1).join('/') || '.';
    action('Copy path', async () => { await navigator.clipboard.writeText(path); status.textContent = 'Path copied'; });
    action('Reveal in tree', () => showDirectory(parent, path));
    action('Pin folder', () => showDirectory(parent));
    breadcrumb.append(actions);
  }
  function closePalette() {
    if (palette) palette.hidden = true;
    $('app').inert = false;
    clearTimeout(searchTimer); searchSequence++;
    paletteReturnFocus?.focus?.(); paletteReturnFocus = null;
  }
  function highlightMatch(element, text, query) {
    const needle = query.toLowerCase();
    if (!needle || query.startsWith('/')) { element.textContent = text; return; }
    let at = 0; const positions = [];
    for (const char of needle) {
      const found = text.toLowerCase().indexOf(char, at);
      if (found < 0) { element.textContent = text; return; }
      positions.push(found); at = found + 1;
    }
    let last = 0;
    for (const position of positions) {
      if (position > last) element.append(document.createTextNode(text.slice(last, position)));
      const mark = document.createElement('mark'); mark.textContent = text[position]; element.append(mark);
      last = position + 1;
    }
    element.append(document.createTextNode(text.slice(last)));
  }
  function drawSearch() {
    searchResults.replaceChildren();
    const query = searchInput.value.trim();
    shownHits = query ? searchHits : [
      ...recentFiles.map(path => entries().find(f => f.path === path)).filter(f => f && !f.path.startsWith('message:')),
      ...(listing.roots || []).map(root => ({ ...root, kind: 'folder', label: 'Open folder · ' + root.label }))
    ];
    const groups = new Map();
    for (const [index, hit] of shownHits.entries()) {
      const file = listing.files?.find(f => f.path === hit.path);
      const group = hit.kind ? (query ? 'Open exact path' : 'Browse locations') : recentFiles.includes(hit.path) ? 'Recent' : file && !file.manual ? 'Captured changes' : 'Files in opened locations';
      if (!groups.has(group)) groups.set(group, []);
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'review-search-hit' + (index === searchPosition ? ' active' : '');
      const title = document.createElement('span'); highlightMatch(title, hit.kind ? hit.label : hit.path.split('/').at(-1), query);
      const subtitle = document.createElement('small'); highlightMatch(subtitle, hit.path, query);
      subtitle.append(document.createTextNode(file?.manual ? ' · opened, no recorded diff' : file ? ' · captured change' : ''));
      button.append(title, subtitle); button.title = hit.path;
      button.onclick = () => (hit.kind ? addLocation(hit.path) : openBrowsable(hit.path)).catch(report);
      groups.get(group).push(button);
    }
    for (const [label, buttons] of groups) {
      const heading = document.createElement('div'); heading.className = 'review-search-group'; heading.textContent = label;
      searchResults.append(heading, ...buttons);
    }
    if (!shownHits.length) {
      const hint = document.createElement('p');
      hint.textContent = query ? 'No matches in opened locations. Try an exact path or a shorter name.' : 'Search the project and explicitly opened locations by filename.';
      searchResults.append(hint);
    }
  }
  async function searchFiles() {
    const id = ++searchSequence, query = searchInput.value.trim();
    if (!query) { searchHits = []; drawSearch(); return; }
    try {
      const data = await get('/api/review/search?q=' + encodeURIComponent(query));
      if (id !== searchSequence || palette.hidden) return;
      searchHits = [...(data.exact ? [data.exact] : []), ...data.results.filter(hit => hit.path !== data.exact?.path)]; searchPosition = 0; drawSearch();
      if (data.truncated) { const hint = document.createElement('p'); hint.textContent = 'Search capped for speed; try a more specific name or open the folder.'; searchResults.append(hint); }
    } catch (error) { if (id === searchSequence) report(error); }
  }
  function showPalette() {
    if (!$('reviewFeedbackDialog').hidden || editing()) return;
    paletteReturnFocus = document.activeElement;
    palette.hidden = false; $('app').inert = true;
    searchInput.value = ''; searchHits = []; searchPosition = 0;
    drawSearch(); searchInput.focus();
  }
  function report(error) {
    if (saveError) saveStatus('Could not save — ' + saveError.message, true);
    else status.textContent = error.message;
    if (palette && !palette.hidden) $('reviewSearchError').textContent = error.message;
  }
  function positionLineNumbers(frame) {
    const pre = frame.querySelector('pre'), gutter = frame.querySelector('.review-code-gutter');
    if (!pre || !gutter || !frame.isConnected) return;
    const top = pre.getBoundingClientRect().top;
    const positions = Array.from(pre.querySelectorAll('.review-line-anchor'), anchor => Math.round(anchor.getBoundingClientRect().top - top));
    const labels = document.createDocumentFragment();
    positions.forEach((position, index) => {
      const label = document.createElement('span');
      label.textContent = String(index + 1);
      label.style.top = position + 'px';
      labels.append(label);
    });
    gutter.replaceChildren(labels);
  }
  function scheduleLineNumbers(frame) {
    if (!frame) return;
    pendingLineFrames.add(frame);
    if (lineFrame) return;
    lineFrame = requestAnimationFrame(() => {
      lineFrame = 0;
      const frames = [...pendingLineFrames]; pendingLineFrames.clear();
      for (const pending of frames) positionLineNumbers(pending);
    });
  }
  function addLineAnchors(pre, source, maxLines = 20000) {
    const code = pre.querySelector('code');
    if (!code || code.textContent !== source) return 'unavailable';
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    // A pathological 512 KiB file of tiny lines should not create 100,000 DOM nodes.
    if (starts.length > maxLines) return 'too-many';
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const nodes = []; let node;
    while ((node = walker.nextNode())) nodes.push(node);
    let offset = 0, next = 0;
    const anchor = () => { const element = document.createElement('span'); element.className = 'review-line-anchor'; element.setAttribute('aria-hidden', 'true'); return element; };
    for (const text of nodes) {
      const length = text.length;
      const positions = [];
      while (next < starts.length && starts[next] < offset + length) positions.push(starts[next++] - offset);
      for (const position of positions.reverse()) {
        const tail = text.splitText(position);
        tail.parentNode.insertBefore(anchor(), tail);
      }
      offset += length;
    }
    if (next < starts.length) code.append(anchor()); // Empty file or final blank line.
    return 'ready';
  }
  function renderContent() {
    if (lineObserver) { lineObserver.disconnect(); lineObserver = null; }
    cancelAnimationFrame(lineFrame); lineFrame = 0; pendingLineFrames.clear();
    const content = $('content');
    if (sourceView && current?.isMarkdown) {
      const pre = document.createElement('pre'); pre.className = 'md-block review-raw-source';
      pre.dataset.offsetStart = '0'; pre.dataset.offsetEnd = String(planData.plan.length);
      const code = document.createElement('code'); code.textContent = planData.plan; pre.append(code);
      content.replaceChildren(pre);
    } else content.innerHTML = planData.planHtml || '';
    const rawSource = current?.kind === 'file' && !current.isMarkdown || !!(sourceView && current?.isMarkdown);
    const frames = [];
    let markdownLinesNumbered = 0;
    const frameCode = (pre, source) => {
      const lineCount = source.split('\n').length;
      const renderedMarkdown = current?.isMarkdown && !sourceView;
      const lineState = addLineAnchors(pre, source, renderedMarkdown ? Math.max(0, 20000 - markdownLinesNumbered) : 20000);
      const frame = document.createElement('div'); frame.className = 'review-code-frame';
      frame.classList.toggle('word-wrap', wordWrap);
      const gutter = document.createElement('div'); gutter.className = 'review-code-gutter';
      gutter.setAttribute('aria-hidden', 'true');
      gutter.style.width = Math.max(3, String(lineCount).length + 2) + 'ch';
      pre.replaceWith(frame); frame.append(gutter, pre);
      if (lineState === 'ready') {
        frames.push(frame);
        if (renderedMarkdown) markdownLinesNumbered += lineCount;
      }
      else {
        const notice = document.createElement('p'); notice.className = 'review-lines-notice';
        notice.textContent = lineState === 'too-many' ? 'Line numbers unavailable above 20,000 lines. Word wrap still works.' : 'Line numbers unavailable for this code block. Word wrap still works.';
        frame.before(notice);
      }
    };
    if (rawSource) {
      const pre = content.querySelector(':scope > pre.md-block');
      if (pre) frameCode(pre, planData.plan);
    } else if (current?.isMarkdown) {
      // Rendered Markdown code fences/indented blocks get their own numbered,
      // wrappable frame; prose and inline `code` remain untouched.
      for (const pre of content.querySelectorAll('pre')) {
        const code = pre.querySelector(':scope > code');
        if (code) frameCode(pre, code.textContent);
      }
    }
    highlightAnnotations();
    if (frames.length) {
      lineObserver = new ResizeObserver(entries => {
        for (const entry of entries) scheduleLineNumbers(entry.target.closest('.review-code-frame'));
      });
      for (const frame of frames) {
        lineObserver.observe(frame.querySelector('pre'));
        scheduleLineNumbers(frame);
      }
    }
  }
  function display() {
    const hasDiff = current?.patch != null;
    if (!hasDiff) view = 'document';
    diffButton.disabled = !hasDiff;
    diffButton.title = hasDiff ? 'Captured before/after diff' : 'No recorded before-version. Opening a file does not create a diff.';
    sourceButton.hidden = !current?.isMarkdown;
    sourceButton.textContent = sourceView ? 'Rendered' : 'Source';
    sourceButton.title = sourceView ? 'Show rendered Markdown' : 'Show raw Markdown source';
    sourceButton.disabled = view === 'diff';
    const rawSource = current?.kind === 'file' && !current.isMarkdown || !!(sourceView && current?.isMarkdown);
    const renderedCode = !!(current?.isMarkdown && !sourceView && $('content').querySelector('.review-code-frame'));
    wrapButton.hidden = !rawSource && !renderedCode;
    wrapButton.disabled = view === 'diff';
    wrapButton.setAttribute('aria-pressed', String(wordWrap));
    wrapButton.textContent = wordWrap ? 'Wrap: on' : 'Wrap: off';
    wrapButton.title = wordWrap ? 'Turn off word wrap (show horizontal scrolling)' : 'Wrap long source lines';
    sourceBadge.textContent = !current ? 'Select a document' : current.kind === 'response' ? 'Agent response' : current.recorded ? 'Captured change' : 'Discovered on disk · no recorded diff';
    sourceBadge.title = current?.kind === 'file' && !current.recorded ? 'Opening this file did not capture an earlier version or identify who created it.' : '';
    documentHeader.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(view === button.dataset.view)));
    $('content').style.display = view === 'document' ? 'block' : 'none';
    patch.style.display = view === 'diff' ? 'block' : 'none';
    hideFloatingToolbar();
  }
  async function compareDisk() {
    if (!current?.stale || current.kind !== 'file') return;
    await flush();
    const result = await get('/api/review/disk-comparison?path=' + encodeURIComponent(current.path));
    const comparison = $('reviewDiskComparison'); comparison.hidden = false; comparison.open = true;
    comparison.querySelector('pre').textContent = result.error || result.patch || 'No disk differences.';
  }
  function editing() {
    if (popupActive || $('annList').dataset.editingId) {
      status.textContent = 'Save or cancel the annotation you are editing first.';
      return true;
    }
    return false;
  }
  async function open(path) {
    if (busy || editing()) return;
    busy = true; buttons();
    try {
      await flush();
      const data = await get('/api/review/document?path=' + encodeURIComponent(path) + '&scope=' + scope);
      ready = false;
      if (current?.path !== data.path) { sourceView = false; crumbsExpanded = false; }
      current = data; planData = data; annotations = data.annotations;
      _hoveredBlock = null;
      renderContent();
      $('sourceInfo').textContent = data.sourceInfo;
      warning.textContent = data.warning || '';
      $('reviewDiskComparison').hidden = true;
      if (data.stale) {
        const compare = document.createElement('button'); compare.type = 'button'; compare.textContent = 'Compare with disk';
        compare.onclick = () => compareDisk().catch(report); warning.append(' ', compare);
      }
      patch.replaceChildren();
      for (const line of (data.patch || '').split('\n')) {
        const span = document.createElement('span');
        span.textContent = line + '\n';
        if (line.startsWith('+')) span.style.color = 'var(--success, #238636)';
        else if (line.startsWith('-')) span.style.color = 'var(--danger, #cf4848)';
        patch.append(span);
      }
      $('mdViewer').scrollTop = 0;
      updateAll(); ready = true;
      if (recentFiles.includes(path)) recentFiles.splice(recentFiles.indexOf(path), 1);
      recentFiles.unshift(path); if (recentFiles.length > 8) recentFiles.length = 8;
      drawTree(); drawBreadcrumb(); display(); drawBrowser();
    } finally { busy = false; buttons(); }
  }
  async function refresh() {
    listing = await get('/api/review/list');
    $('reviewDemoNotice').hidden = !listing.demo;
    const requested = listing.focus !== focusSeen;
    if (focusSeen && requested) window.focus();
    focusSeen = listing.focus;
    if (requested && listing.targetFolder) expanded.add(listing.targetFolder);
    drawTree(); drawBrowser();
    // Only rescan folders the user expanded, at a modest interval. This picks
    // up script-generated outputs without watching all of /tmp or the project.
    if (Date.now() - lastFolderScan > 8000) {
      lastFolderScan = Date.now();
      for (const path of [...expanded].slice(0, 8)) loadFolder(path, true);
    }
    if (requested && listing.target) {
      const destination = entries().find(f => f.path === listing.target);
      if (destination && !destination.latest) { scope = 'session'; scopeSelect.value = scope; }
      await open(listing.target);
    }
    return listing;
  }
  async function done() {
    if (busy || editing()) return;
    busy = true; buttons();
    try {
      await flush();
      const result = await get('/api/review/preview');
      if (!result.feedback) return;
      $('reviewFeedbackText').textContent = result.feedback;
      $('reviewFeedbackTitle').textContent = listing.demo ? 'Fixture feedback preview' : `Review feedback before adding to ${host()}`;
      $('reviewFeedbackConfirm').textContent = listing.demo ? 'Close preview' : `Append to ${host()} draft`;
      $('reviewFeedbackExplanation').textContent = listing.demo ? `Fixture preview only; ${host()}’s editor stays untouched.` : result.editorHasText
        ? `This feedback will be appended after the text already in ${host()}’s editor. Nothing is sent automatically.`
        : (listing.hostNote || `This feedback will be placed in ${host()}’s editor. Nothing is sent automatically.`);
      $('reviewFeedbackDialog').hidden = false; $('app').inert = true;
      $('reviewFeedbackConfirm').focus();
    } catch (error) { report(error); }
    finally { busy = false; buttons(); }
  }
  async function confirmDone() {
    if (busy) return;
    busy = true; buttons();
    try {
      await flush();
      const result = await postJson('/api/review/done', {});
      $('reviewFeedbackDialog').hidden = true; $('app').inert = false;
      if (result.demo) {
        status.textContent = `Fixture preview only — nothing was sent to ${host()}.`;
      } else {
        ready = false; annotations = []; updateAll(); ready = true;
        await refresh();
        status.textContent = result.message || `Notes appended to ${host()}’s editor. Review the draft there before sending.`;
      }
    } catch (error) { report(error); }
    finally { busy = false; buttons(); }
  }
  async function init() {
    document.body.classList.add('review-workspace');
    const css = document.createElement('style');
    css.textContent = '.review-nav{width:250px;min-width:195px;overflow:auto;padding:14px;border-right:1px solid var(--border-color);font-size:12px}.review-nav select,.review-nav button,.review-search input{color:var(--text-primary);background:var(--bg-secondary);border:1px solid var(--border-color);padding:7px;border-radius:5px}.review-nav select{width:100%;margin-bottom:10px}.review-file{display:block;text-align:left;width:100%;overflow-wrap:anywhere;margin:3px 0;cursor:pointer}.review-file.selected{outline:1px solid var(--accent)}.review-nav details{padding-left:8px}.review-nav summary{cursor:pointer;padding:6px 0;overflow-wrap:anywhere}.review-nav p{font-size:11px;color:var(--text-secondary)}.review-warning{color:var(--text-secondary);padding:8px 16px;font-size:12px}.review-warning:empty{display:none}.review-patch{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--review-code-font-size,14px);line-height:1.6;user-select:text}.review-status{font-size:11px;color:var(--text-secondary);padding:8px 16px}.review-search[hidden]{display:none}.review-search{position:fixed;inset:0;z-index:10000;background:#0009;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}.review-search-panel{width:min(640px,92vw);max-height:70vh;overflow:auto;padding:16px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:9px;box-shadow:0 18px 45px #0008}.review-search input{width:100%;box-sizing:border-box;font-size:15px}.review-search-hit{display:block;width:100%;text-align:left;color:var(--text-primary);background:transparent;border:0;padding:10px;cursor:pointer;overflow-wrap:anywhere}.review-search-hit.active,.review-search-hit:hover{background:var(--bg-secondary)}.review-search-actions{display:flex;gap:8px;margin-top:10px}.review-search-actions button{color:var(--text-primary);background:var(--bg-secondary);border:1px solid var(--border-color);padding:7px;border-radius:5px;cursor:pointer}#reviewDemoNotice{padding:8px;border:1px solid var(--accent);border-radius:5px}#reviewDemoPreview{max-height:28vh;overflow:auto;border-bottom:1px solid var(--border-color);padding:8px 16px;color:var(--text-primary);background:var(--bg-secondary)}#reviewDemoPreview[hidden],#reviewDemoNotice[hidden]{display:none}#reviewDemoPreview pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}';
    document.head.append(css);
    const breadcrumbStyle = document.createElement('style');
    breadcrumbStyle.textContent = '.review-breadcrumb{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;margin-bottom:14px;padding:6px 0;border-bottom:1px solid var(--border-color);color:var(--text-secondary);font-size:12px;white-space:nowrap}.review-breadcrumb[hidden]{display:none}.review-breadcrumb>button{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.review-breadcrumb button{color:var(--text-primary);background:transparent;border:0;border-radius:4px;padding:4px;cursor:pointer;font:inherit}.review-breadcrumb button:hover,.review-breadcrumb button:focus-visible{background:var(--bg-secondary);outline:1px solid var(--accent)}.review-crumb-separator{flex:none}.review-crumb-file{flex:0 1 auto;min-width:min-content;overflow-wrap:anywhere;white-space:normal;color:var(--text-primary);font-weight:600}.review-crumb-actions{display:flex;flex:0 0 auto;gap:3px;margin-left:auto}.review-crumb-actions button{border:1px solid var(--border-color);white-space:nowrap}@media(max-width:1100px){.review-breadcrumb{flex-wrap:wrap}.review-crumb-actions{width:100%;margin-left:0}}';
    document.head.append(breadcrumbStyle);
    nav = document.createElement('aside'); nav.className = 'review-nav';
    nav.innerHTML = '<button id="reviewFind" type="button" title="Find files or paste a path (⌘P)">⌕ Find files or paste a path… <kbd>⌘P</kbd></button><p id="reviewDemoNotice" hidden>Fixture · separate notes. Feedback is never sent to Pi.</p><div id="reviewTotal"></div><select aria-label="Review scope" title="Last request includes all internal agent and tool turns until the next user message"><option value="request">Last request</option><option value="session">Whole session</option></select><strong>Agent response</strong><div id="reviewResponses"></div><hr><strong>Files in review</strong><div id="reviewTree"></div><hr><strong>Browse locations</strong><p>Project and folders you explicitly opened · text ≤512 KiB</p><p><button id="reviewOpenPath" type="button">Open folder or path…</button></p><div id="reviewBrowserTree"></div><div class="review-views"><button data-view="document" type="button">Document</button><button data-view="diff" type="button">Diff</button></div><button id="reviewSource" type="button">Source</button><button id="reviewWordWrap" type="button" aria-pressed="true">Wrap: on</button><span id="reviewSourceBadge" class="review-source-badge"></span><button id="reviewRefresh" type="button">Refresh document</button>';
    document.querySelector('.main-content').prepend(nav);
    scopeSelect = nav.querySelector('select'); $('reviewHeaderScope').append(scopeSelect);
    tree = $('reviewTree'); responseTree = $('reviewResponses'); browserTree = $('reviewBrowserTree'); total = $('reviewTotal');
    palette = document.createElement('div'); palette.className = 'review-search'; palette.hidden = true;
    palette.innerHTML = '<div class="review-search-panel" role="dialog" aria-label="Find a file"><input id="reviewSearchInput" type="text" maxlength="200" autocomplete="off" placeholder="Fuzzy filename or exact path…" aria-label="Find a file"><div id="reviewSearchResults"></div><div class="review-search-actions"><button id="reviewAddLocation" type="button">Open exact path or folder</button><button id="reviewCloseSearch" type="button">Close</button></div><p id="reviewSearchError" role="status"></p></div>';
    document.body.append(palette);
    searchInput = $('reviewSearchInput'); searchResults = $('reviewSearchResults');
    $('reviewFind').onclick = showPalette;
    $('reviewOpenPath').onclick = showPalette;
    $('reviewToggleNav').onclick = () => { nav.classList.toggle('collapsed'); $('reviewToggleNav').setAttribute('aria-expanded', String(!nav.classList.contains('collapsed'))); };
    $('reviewToggleNav').setAttribute('aria-expanded', 'true');
    if (window.matchMedia('(max-width: 560px)').matches) { nav.classList.add('collapsed'); $('reviewToggleNav').setAttribute('aria-expanded', 'false'); }
    const notesPanel = $('annPanel');
    const toggleNotes = () => { notesPanel.classList.toggle('collapsed'); $('reviewShowNotes').setAttribute('aria-expanded', String(!notesPanel.classList.contains('collapsed'))); };
    $('reviewShowNotes').onclick = toggleNotes; $('reviewToggleNotes').onclick = toggleNotes;
    $('reviewShowNotes').setAttribute('aria-expanded', 'true');
    if (window.matchMedia('(max-width: 900px)').matches) { notesPanel.classList.add('collapsed'); $('reviewShowNotes').setAttribute('aria-expanded', 'false'); }
    $('reviewFeedbackCancel').onclick = () => { $('reviewFeedbackDialog').hidden = true; $('app').inert = false; $('btnFeedback').focus(); };
    $('reviewFeedbackConfirm').onclick = () => listing.demo ? $('reviewFeedbackCancel').click() : confirmDone();
    $('reviewFeedbackDialog').onclick = e => { if (e.target === $('reviewFeedbackDialog')) $('reviewFeedbackCancel').click(); };
    $('reviewFeedbackDialog').onkeydown = e => {
      if (e.key !== 'Tab') return;
      const first = $('reviewFeedbackCancel'), last = $('reviewFeedbackConfirm');
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    $('reviewCloseSearch').onclick = closePalette;
    palette.addEventListener('click', e => { if (e.target === palette) closePalette(); });
    palette.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const focusable = [searchInput, $('reviewAddLocation'), $('reviewCloseSearch')];
      if (e.shiftKey && document.activeElement === focusable[0]) { e.preventDefault(); focusable.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === focusable.at(-1)) { e.preventDefault(); focusable[0].focus(); }
    });
    $('reviewAddLocation').onclick = () => addLocation(searchInput.value).catch(report);
    searchInput.addEventListener('input', () => {
      $('reviewSearchError').textContent = '';
      searchSequence++; searchHits = []; searchPosition = 0; drawSearch();
      clearTimeout(searchTimer); searchTimer = setTimeout(searchFiles, 160);
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); searchPosition = Math.max(0, Math.min(shownHits.length - 1, searchPosition + (e.key === 'ArrowDown' ? 1 : -1))); drawSearch();
        searchResults.querySelector('.review-search-hit.active')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = shownHits[searchPosition];
        (hit ? hit.kind ? addLocation(hit.path) : openBrowsable(hit.path) : addLocation(searchInput.value)).catch(report);
      }
    });
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); showPalette(); }
      else if (e.key === 'Escape' && !palette.hidden) { e.preventDefault(); closePalette(); }
      else if (e.key === 'Escape' && !$('reviewFeedbackDialog').hidden) { e.preventDefault(); $('reviewFeedbackCancel').click(); }
    }, true);
    warning = document.createElement('div'); warning.className = 'review-warning';
    document.querySelector('.main-content').before(warning);
    const diskComparison = document.createElement('details'); diskComparison.id = 'reviewDiskComparison'; diskComparison.hidden = true;
    diskComparison.innerHTML = '<summary>Disk comparison · not a captured agent diff</summary><pre></pre>';
    document.querySelector('.main-content').before(diskComparison);
    const demoPreview = document.createElement('details'); demoPreview.id = 'reviewDemoPreview'; demoPreview.hidden = true;
    demoPreview.innerHTML = '<summary>Demo feedback preview · close to return to review</summary><pre></pre>';
    document.querySelector('.main-content').before(demoPreview);
    status = document.createElement('div'); status.className = 'review-status'; status.textContent = 'Connected · drafts are saved locally by Pi';
    document.querySelector('.toolbar').before(status);
    breadcrumb = document.createElement('nav'); breadcrumb.className = 'review-breadcrumb'; breadcrumb.hidden = true;
    documentHeader = document.createElement('header'); documentHeader.className = 'review-document-header';
    const documentTools = document.createElement('div'); documentTools.className = 'review-document-tools';
    documentTools.append(nav.querySelector('.review-views'), $('reviewSource'), $('reviewWordWrap'), $('reviewSourceBadge'), $('reviewRefresh'));
    documentHeader.append(breadcrumb, documentTools);
    $('mdViewer').insertBefore(documentHeader, $('content'));
    sourceButton = $('reviewSource'); wrapButton = $('reviewWordWrap'); sourceBadge = $('reviewSourceBadge'); diffButton = documentHeader.querySelector('[data-view="diff"]');
    patch = document.createElement('pre'); patch.className = 'review-patch'; patch.style.display = 'none'; $('mdViewer').append(patch);
    $('btnApprove').style.display = 'none';
    scopeSelect.onchange = async () => {
      if (editing()) { scopeSelect.value = scope; return; }
      scope = scopeSelect.value; drawTree();
      const target = current?.path || visibleEntries()[0]?.path;
      if (target) await open(target).catch(report);
      else {
        try { await flush(); } catch (error) { report(error); return; }
        ready = false; current = null; annotations = []; planData = { plan: '', planHtml: '' };
        $('content').textContent = 'Nothing captured in this request yet. Find a file, open a folder, or select an agent response.';
        $('sourceInfo').textContent = 'Session review'; warning.textContent = ''; patch.textContent = '';
        updateAll(); ready = true; drawBreadcrumb(); display(); buttons();
      }
    };
    documentHeader.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { if (button.disabled) return; view = button.dataset.view; display(); });
    sourceButton.onclick = () => { sourceView = !sourceView; renderContent(); display(); };
    wrapButton.onclick = () => {
      wordWrap = !wordWrap;
      const frames = $('content').querySelectorAll('.review-code-frame');
      for (const frame of frames) { frame.classList.toggle('word-wrap', wordWrap); scheduleLineNumbers(frame); }
      display();
    };
    $('reviewRefresh').onclick = () => current ? open(current.path).catch(report) : refresh().catch(report);
    await refresh();
    const first = visibleEntries()[0];
    if (!current && first) await open(first.path);
    else if (!current) { $('content').textContent = 'Nothing captured yet. Find a file, open a folder, or wait for an agent response.'; display(); }
    ready = true; buttons();
    setInterval(() => refresh().catch(error => { status.textContent = `Disconnected — reopen /annotate after reloading ${host()}. ` + error.message; }), 4000);
    window.addEventListener('pagehide', () => {
      // Normal saves happen immediately on annotation changes; keepalive is an
      // additional best effort for closing immediately after the last edit.
      const data = payload();
      if (data) fetch('/api/review/draft', { method: 'POST', keepalive: true, headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH_HEADERS), body: JSON.stringify(data) }).catch(() => {});
      fetch('/api/review/closed', { method: 'POST', keepalive: true, headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH_HEADERS), body: '{}' }).catch(() => {});
    });
  }
  return { init, changed, buttons, done };
})() : null;
