// Copies KaTeX's stylesheet (woff2 fonts only) and fonts into dist/ for the UI server.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const katex = dirname(require.resolve("katex/package.json"));
const css = readFileSync(join(katex, "dist/katex.min.css"), "utf8")
  .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
writeFileSync("dist/katex.css", css);
rmSync("dist/fonts", { recursive: true, force: true });
mkdirSync("dist/fonts", { recursive: true });
for (const font of readdirSync(join(katex, "dist/fonts")).filter(f => f.endsWith(".woff2"))) copyFileSync(join(katex, "dist/fonts", font), join("dist/fonts", font));
