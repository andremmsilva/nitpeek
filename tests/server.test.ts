import { startAnnotationServer } from "../server.ts";
import http from "node:http";
import { readFileSync } from "node:fs";
import { renderMarkdown } from "../markdown.ts";

const htmlContent = readFileSync(new URL("../form/annotate.html", import.meta.url), "utf-8");
const markdown = "# Hello\n\nThis is **bold** text and plain text.\n\n- a\n- b\n";
// Demo payload with everything that can break the inline JSON embedding:
// newlines, quotes, backslashes and a script-closing sequence.
const demoMarkdown = "Demo 'quoted' text with a backslash \\ and a fence:\n\n```js\nconst x = \"<tag>\";\n```\n";
const demoHtml = '<pre data-x="1">\n</script><b>not markup</b>\n</pre>';
const server = await startAnnotationServer({
  markdown,
  renderedHtml: renderMarkdown(markdown),
  demoHtml,
  demoMarkdown,
  htmlContent,
  mode: "annotate",
  sourceInfo: "test.md",
  gate: false,
});

const port = new URL(server.url).port;

function req(path: string, opts: { method?: string; token?: string; host?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const data = opts.body === undefined ? null : JSON.stringify(opts.body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: {
          ...(opts.host ? { Host: opts.host } : {}),
          ...(opts.token ? { "X-Annotation-Token": opts.token } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

// Page + token extraction
const page = await req("/");
const raw = page.body.match(/JSON\.parse\('((?:\\.|[^'\\])*)'\)/)?.[1] ?? "";
let inline: Record<string, string> | null = null;
try {
  // Browser semantics: the JS string literal is decoded before JSON.parse.
  inline = JSON.parse(new Function(`return '${raw}'`)() as string);
} catch {
  inline = null;
}
const token = inline?.sessionToken ?? "";
check("GET / serves the page", page.status === 200);
check("English quick labels present", page.body.includes("Needs Clarification"));
const footerHtml = page.body.slice(page.body.indexOf('<div class="toolbar">'), page.body.indexOf('<div id="settingsDialog"'));
check("settings modal keeps theme out of the footer", footerHtml.includes('id="openSettings"') && !footerHtml.includes('id="themeSelect"') && page.body.includes('id="themeSelect"'));
check("settings offers persisted source-code font size", page.body.includes('id="codeFontSize"') && page.body.includes("pi-annotate-code-font-size") && page.body.includes("--review-code-font-size"));
const inlineScript = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
let scriptParses = false;
try { new Function(inlineScript); scriptParses = true; } catch {}
check("injected client script parses", scriptParses);
check("no CJK left in page", !/[\u4e00-\u9fff]/.test(page.body));
check("session token embedded", typeof token === "string" && token.length > 10);
check("inline payload parses after JS-literal decoding", inline !== null);
check("default UI settings are system theme and 14px code", inline?.settings?.theme === "system" && inline?.settings?.codeFontSize === 14);
check("demo markdown round-trips byte for byte", inline?.demoMarkdown === demoMarkdown);
check("demo html round-trips byte for byte", inline?.demoHtml === demoHtml);
check("payload cannot close the script tag", !page.body.includes("</script><b>"));
check("framing denied", page.headers["x-frame-options"] === "DENY");

// Unauthorized API access
check("GET /api/plan without token -> 403", (await req("/api/plan")).status === 403);
check("GET /api/health without token -> 403", (await req("/api/health")).status === 403);

// Authorized API access
const plan = await req("/api/plan", { token });
check("GET /api/plan with token -> 200", plan.status === 200);
check("plan body matches", plan.status === 200 && JSON.parse(plan.body).plan.includes("Hello"));
check("plan response carries pre-rendered html", plan.status === 200 && (JSON.parse(plan.body).planHtml ?? "").includes("md-block"));
check("heartbeat with token -> 200", (await req("/api/health", { token })).status === 200);

// Host header validation
check("GET / with foreign Host -> 403", (await req("/", { host: "evil.example.com" })).status === 403);
check("GET /api/plan with foreign Host + token -> 403", (await req("/api/plan", { token, host: "evil.example.com" })).status === 403);

// Feedback without token must not resolve the decision
check("POST feedback without token -> 403", (await req("/api/feedback", { method: "POST", body: { feedback: "csrf" } })).status === 403);

// Real feedback resolves the decision
const good = await req("/api/feedback", {
  method: "POST",
  token,
  body: {
    annotations: [
      { id: "a1", type: "comment", text: "Nice", originalText: "Hello", range: { startOffset: 0, endOffset: 5, textPreview: "Hello" }, createdAt: 0 },
    ],
  },
});
check("POST feedback with token -> 200", good.status === 200);
const decision = await server.waitForDecision();
check("decision resolved with structured annotations", decision.action === "feedback" && decision.annotations?.length === 1);

server.stop();
console.log(failures === 0 ? "\nSERVER SUITE PASSED" : `\n${failures} SERVER TEST(S) FAILED`);
process.exit(failures ? 1 : 0);
