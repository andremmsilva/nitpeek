// Compiles one TikZ picture to SVG in its own process (see core/tikz.ts).
// Plain JavaScript so both Node (Pi) and Bun (Claude daemon) can run it.
import * as tikzjax from "node-tikzjax";

// CommonJS default export, as seen from Node or Bun.
const tex2svg = typeof tikzjax.default === "function" ? tikzjax.default : tikzjax.default.default;

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { source, preamble } = JSON.parse(input);
const log = [];
console.log = console.info = console.warn = console.error = (...args) => log.push(args.join(" "));
let result;
try {
  const svg = await tex2svg(source, { showConsole: true, addToPreamble: preamble, texPackages: {}, tikzLibraries: "" });
  result = { svg };
} catch (error) {
  // TeX reports errors as "! Message." followed by context lines.
  const lines = log.join("\n").split("\n");
  const at = lines.findIndex(line => line.startsWith("! "));
  result = { error: at >= 0 ? lines.slice(at, at + 3).join("\n").trim() : String(error?.message ?? error) };
}
process.stdout.write("\n@@nitpeek@@" + JSON.stringify(result));
process.exit(0);
