// Browser smoke test of the built UI against the demo session. Skipped without Chrome.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
process.env.NITPEEK_HOME ||= "/tmp/nitpeek-test-home";
const { startWorkspace } = await import("../core/workspace.ts");
const { createDemoStore } = await import("../demo/fixture.ts");
const { suite } = await import("./helpers.ts");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) { console.log("SKIP ui (no Chrome at CHROME_PATH)"); process.exit(0); }
const { default: puppeteer } = await import("puppeteer-core");

suite("ui: select → note → margin, diff gutter note, Done", async () => {
  const demo = createDemoStore();
  const delivered: string[] = [];
  const workspace = await startWorkspace(demo.store, { name: "Test", deliveryNote: () => "test", deliver: async text => { delivered.push(text); return "Delivered to the test."; } });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => errors.push(String(e)));
    const wait = (ms = 400) => new Promise(r => setTimeout(r, ms));
    await page.goto(workspace.url);
    await page.waitForSelector(".prose");
    assert.match(await page.$eval(".doc-head", e => e.textContent!), /Reply.*The threshold should be 0\.75/, "opens the newest reply first");

    // Select a phrase even when it spans several text nodes (inline markup).
    const select = (root: string, phrase: string) => page.evaluate((root, phrase) => {
      const el = document.querySelector(root)!;
      const at = el.textContent!.indexOf(phrase);
      if (at < 0) return false;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0, started = false;
      for (let n; (n = walker.nextNode());) {
        const length = n.nodeValue!.length;
        if (!started && at < offset + length) { range.setStart(n, at - offset); started = true; }
        if (started && at + phrase.length <= offset + length) { range.setEnd(n, at + phrase.length - offset); break; }
        offset += length;
      }
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }, root, phrase);
    const saveNote = async () => { await page.keyboard.down("Meta"); await page.keyboard.press("Enter"); await page.keyboard.up("Meta"); await wait(600); };

    // Prose: select across an inline <strong> element.
    assert.ok(await select(".prose", "reads the threshold"));
    await page.waitForSelector(".toolbar");
    assert.equal(await page.$eval(".toolbar .chip.on", e => e.textContent), "Change1", "a plain statement suggests Change");
    await page.keyboard.press("3");
    await page.waitForSelector(".composer textarea");
    await page.keyboard.type("Where is the default documented?");
    await saveNote();
    assert.equal(await page.$$eval("mark.np-note.i-question", m => m.length) > 0, true, "highlight drawn");
    assert.match(await page.$eval(".card.i-question", e => e.textContent!), /Where is the default documented\?/);

    // An offer in a reply suggests Reply, and Enter takes the suggestion.
    assert.ok(await select(".prose", "Want me to add the validation now?"));
    await page.waitForSelector(".toolbar");
    assert.equal(await page.$eval(".toolbar .chip.on", e => e.textContent), "Reply2");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".composer.i-reply textarea");
    await page.keyboard.type("Yes, go ahead.");
    await saveNote();

    // Diff: a note from a line number, then shown in the File view too.
    await page.click('.row[data-path$="runner.py"]');
    await page.waitForSelector(".code.diff");
    await page.$eval('.ln.add[data-new="6"] .gutter:nth-child(2)', e => (e as HTMLElement).click());
    await page.waitForSelector(".composer textarea");
    await page.keyboard.type("Reject thresholds below 0.5.");
    await saveNote();
    assert.equal(await page.$$eval('.ln[data-new="6"] mark.np-note', m => m.length), 1);
    await page.keyboard.press("d");
    await page.waitForSelector('.ln[data-line="6"]');
    await wait(300);
    assert.equal(await page.$$eval('.ln[data-line="6"] mark.np-note', m => m.length), 1, "diff note re-anchors in the File view");

    // Done: preview, send, then "Since last Done" is empty.
    await page.click(".done-button");
    await page.waitForSelector(".preview");
    const preview = await page.$eval(".preview", e => e.textContent!);
    assert.match(preview, /\[1\] question · your response to "The threshold should be 0\.75/);
    assert.match(preview, /\[2\] reply · same response\n> Want me to add the validation now\?\nYes, go ahead\./);
    assert.match(preview, /\[3\] change · src\/runner\.py:6\n> {5}threshold = config\.get\("threshold", 0\.75\)\nReject thresholds below 0\.5\./);
    await page.click(".dialog.done button.primary");
    await wait(800);
    assert.equal(delivered.length, 1);
    assert.match(await page.$eval(".toasts", e => e.textContent!), /Delivered to the test/);
    assert.match(await page.$eval(".sidebar", e => e.textContent!), /No file changes since Done/);

    // Math and numbered code blocks in a reply; `w` toggles wrapping.
    await page.$$eval(".scope-switch button", buttons => (buttons.find(b => /Whole session/.test(b.textContent!)) as HTMLElement).click());
    await wait(400);
    // Older turns start folded; open turn #2 to reach its reply.
    await page.$$eval(".group.request .group-head", heads => (heads.find(h => /^#2/.test(h.textContent!)) as HTMLElement).click());
    await wait(200);
    await page.click('.row[data-path="message:demo-math"]');
    await page.waitForSelector(".prose .np-math");
    await wait(300);
    assert.equal(await page.$$eval(".prose .cl", rows => rows.length), 3, "code block rows");
    assert.ok(await page.$eval(".prose .np-math", e => !!e.shadowRoot?.querySelector(".katex")), "formula rendered in its shadow root");
    const wrapped = await page.$eval(".content", e => e.classList.contains("wrap"));
    await page.keyboard.press("w");
    await wait(200);
    assert.equal(await page.$eval(".content", e => e.classList.contains("wrap")), !wrapped, "w toggles wrap");
    await page.keyboard.press("w");

    // A LaTeX file: clicking a formula selects it whole; the note quotes its source.
    await page.click('.row[data-path$="main.tex"]');
    // The previous document has tabs too: wait for this one.
    await page.waitForFunction(() => /main\.tex/.test(document.querySelector(".doc-head")?.textContent ?? ""));
    await page.waitForSelector(".tabs");
    await page.$$eval(".tabs button", buttons => (buttons.find(b => b.textContent === "Rendered") as HTMLElement).click());
    await page.waitForSelector(".prose .np-math.display");
    await wait(300);
    assert.match(await page.$eval(".prose", e => e.textContent!), /Estimation/);
    // Tables sit in a scroll box; the width button switches every table between fit and scroll.
    await page.waitForSelector(".np-table .tex-table thead th[colspan='2']");
    const tables = () => page.$eval("html", e => e.dataset.tables);
    const toggleTables = () => page.$eval(".np-table-width", h => (h.shadowRoot!.querySelector("button") as HTMLElement).click());
    assert.equal(await tables(), "fit");
    assert.ok(await page.$(".np-table.fits"), "a table whose lines fit hides its width button");
    await page.$eval(".np-table", e => e.parentElement!.style.width = "80px"); // a narrow float: now the modes differ
    await page.waitForSelector(".np-table:not(.fits)", { timeout: 3000 });
    await page.$eval(".np-table", e => e.parentElement!.style.width = "");
    await toggleTables();
    await page.waitForFunction(() => document.documentElement.dataset.tables === "scroll");
    assert.equal(await page.$eval(".tex-table td", e => getComputedStyle(e).whiteSpace), "nowrap", "scroll keeps cell lines whole");
    await toggleTables();
    await page.waitForFunction(() => document.documentElement.dataset.tables === "fit");
    // The TikZ figure compiles and shows as SVG.
    await page.waitForFunction(() => !!document.querySelector(".np-tikz")?.shadowRoot?.querySelector("svg"), { timeout: 30000 });
    await page.click(".prose .np-math.display");
    await page.waitForSelector(".toolbar");
    await page.keyboard.press("3");
    await page.waitForSelector(".composer textarea");
    await page.keyboard.type("Why not QR?");
    await saveNote();
    assert.equal(await page.$$eval(".np-math.np-noted.i-question", m => m.length), 1, "the noted formula is highlighted");
    // A note scrolled out of view: the margin offers to go back to it.
    await page.setViewport({ width: 1400, height: 320 });
    await page.$eval(".doc-scroll", e => e.scrollTo(0, e.scrollHeight));
    await page.waitForSelector(".more-notes.up");
    assert.equal(await page.$(".more-notes.down"), null);
    await page.click(".more-notes.up");
    await page.waitForFunction(() => !document.querySelector(".more-notes"), { timeout: 3000 });
    await wait(500);
    // Switching views keeps the focused note where it was on screen…
    const markY = () => page.$eval(".np-math.np-noted, mark.np-note.active", e => Math.round(e.getBoundingClientRect().top));
    const before = await markY();
    await page.keyboard.press("s");
    await wait(300);
    assert.ok(Math.abs(await markY() - before) < 4, "the focused note stays put across views");
    // …and otherwise the same source line at the top.
    await page.keyboard.press("Escape");
    await page.$eval('.ln[data-line="27"]', e => { const s = e.closest(".doc-scroll")!; s.scrollTop += e.getBoundingClientRect().top - s.getBoundingClientRect().top; });
    await wait(300);
    await page.keyboard.press("s");
    await wait(300);
    const topBlock = await page.$eval(".doc-scroll", s => {
      const t = s.getBoundingClientRect().top;
      return [...s.querySelectorAll<HTMLElement>(".prose .md-block")].find(e => !e.querySelector(".md-block") && e.getBoundingClientRect().bottom > t + 2)!.textContent!;
    });
    assert.match(topBlock, /^\\begin\{tikzpicture\}/, "Source line 27 → the figure in Rendered");
    await page.setViewport({ width: 1400, height: 900 });
    await page.click(".done-button");
    await page.waitForSelector(".preview");
    assert.match(await page.$eval(".preview", e => e.textContent!), /\[1\] question · paper\/main\.tex:14-17\n> \\begin\{equation\}\n> {3}\\hat\\beta = \(X\^\\top X\)/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    workspace.stop();
    rmSync(demo.directory, { recursive: true, force: true });
  }
});
