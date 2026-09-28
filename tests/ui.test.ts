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
    await page.keyboard.press("2");
    await page.waitForSelector(".composer textarea");
    await page.keyboard.type("Where is the default documented?");
    await saveNote();
    assert.equal(await page.$$eval("mark.np-note.i-ask", m => m.length) > 0, true, "highlight drawn");
    assert.match(await page.$eval(".card.i-ask", e => e.textContent!), /Where is the default documented\?/);

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
    assert.match(preview, /\[1\] ask · your response to "The threshold should be 0\.75/);
    assert.match(preview, /\[2\] change · src\/runner\.py:6\n> {5}threshold = config\.get\("threshold", 0\.75\)\nReject thresholds below 0\.5\./);
    await page.click(".dialog.done button.primary");
    await wait(800);
    assert.equal(delivered.length, 1);
    assert.match(await page.$eval(".toasts", e => e.textContent!), /Delivered to the test/);
    assert.match(await page.$eval(".sidebar", e => e.textContent!), /Since last Done.*nothing/s);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    workspace.stop();
    rmSync(demo.directory, { recursive: true, force: true });
  }
});
