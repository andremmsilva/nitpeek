/**
 * A light, forgiving LaTeX reader for the Rendered view of .tex files.
 *
 * Not a TeX engine: it understands the everyday structure of a paper
 * (sections, paragraphs, lists, math, theorem-like and float environments,
 * references and citations) and shows anything else as dimmed source. Like
 * rendered Markdown, every block carries `data-offset-start/end` into the
 * source so notes map back to lines.
 */

import { codeBlock } from "./render.js";
import { mathHtml, stripLabels, type Macros } from "./math.js";
import { tikzHtml } from "./tikz.js";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SECTIONS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
  "alignat", "alignat*", "eqnarray", "eqnarray*", "displaymath", "math"]);
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "CCSXML"]);
/** Read verbatim and not shown: comments, and metadata such as ACM's classification XML. */
const HIDDEN_ENVS = new Set(["comment", "CCSXML"]);
const LIST_ENVS: Record<string, string> = { itemize: "ul", enumerate: "ol", description: "dl" };
const THEOREMS = new Set(["theorem", "lemma", "proposition", "corollary", "definition", "remark", "example", "claim", "conjecture",
  "assumption", "hypothesis", "observation", "fact", "exercise", "problem", "note"]);
const QUOTES = new Set(["quote", "quotation", "verse"]);
const FLOATS: Record<string, string> = { figure: "Figure", "figure*": "Figure", table: "Table", "table*": "Table", algorithm: "Algorithm" };
const TIKZ_ENVS: Record<string, string> = { tikzpicture: "", tikzcd: "tikz-cd", circuitikz: "circuitikz" };
/** Packages node-tikzjax can load. */
const TIKZ_PACKAGES = new Set(["tikz", "pgfplots", "tikz-cd", "circuitikz", "chemfig", "amsmath", "amssymb", "amsfonts", "amstext", "array", "tikz-3dplot", "xcolor"]);
const TRANSPARENT = new Set(["center", "flushleft", "flushright", "minipage", "small", "footnotesize", "document", "frame", "subfigure", "adjustbox", "landscape"]);

const FORMAT: Record<string, [string, string]> = {
  emph: ["<em>", "</em>"], textit: ["<em>", "</em>"], textsl: ["<em>", "</em>"], textbf: ["<strong>", "</strong>"],
  texttt: ["<code>", "</code>"], underline: ["<u>", "</u>"], textsc: ['<span class="tex-sc">', "</span>"],
  text: ["", ""], textrm: ["", ""], textnormal: ["", ""], textsf: ["", ""], mbox: ["", ""], textup: ["", ""], hbox: ["", ""],
};
const SYMBOLS: Record<string, string> = {
  ldots: "…", dots: "…", textellipsis: "…", LaTeX: "LaTeX", TeX: "TeX", LaTeXe: "LaTeX2ε", textendash: "–", textemdash: "—",
  S: "§", P: "¶", copyright: "©", textregistered: "®", texttrademark: "™", ss: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", o: "ø", O: "Ø",
  aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", quad: " ", qquad: "  ", textbackslash: "\\", textasciitilde: "~",
  textbullet: "•", textdegree: "°", dag: "†", ddag: "‡", slash: "/", textless: "<", textgreater: ">", textbar: "|", today: "",
  eg: "e.g.", ie: "i.e.", etal: "et al.",
};
/** Commands that only affect layout; dropped with their arguments ([n] = number of {…} arguments). */
const DROP: Record<string, number> = {
  label: 1, noindent: 0, centering: 0, raggedright: 0, raggedleft: 0, vspace: 1, "vspace*": 1, hspace: 1, "hspace*": 1, smallskip: 0,
  medskip: 0, bigskip: 0, newpage: 0, clearpage: 0, cleardoublepage: 0, pagebreak: 0, nopagebreak: 0, linebreak: 0, newline: 0,
  protect: 0, phantomsection: 0, index: 1, addcontentsline: 3, hfill: 0, vfill: 0, small: 0, footnotesize: 0, scriptsize: 0,
  tiny: 0, large: 0, Large: 0, LARGE: 0, huge: 0, Huge: 0, normalsize: 0, bfseries: 0, itshape: 0, ttfamily: 0, rmfamily: 0,
  sffamily: 0, scshape: 0, upshape: 0, mdseries: 0, normalfont: 0, em: 0, bf: 0, it: 0, tt: 0, rm: 0, sf: 0, sc: 0, relax: 0,
  maketitle: 0, tableofcontents: 0, listoffigures: 0, listoftables: 0, bibliographystyle: 1, frenchspacing: 0, sloppy: 0,
  appendix: 0, onecolumn: 0, twocolumn: 0, indent: 0, par: 0, footnotemark: 0, captionsetup: 1, setlength: 2, addtolength: 2,
  setcounter: 2, thispagestyle: 1, pagestyle: 1, graphicspath: 1, hline: 0, toprule: 0, midrule: 0, bottomrule: 0, cline: 1,
  cmidrule: 1, nocite: 1, Description: 1, keywords: 1, acmConference: 0, ccsdesc: 1, balance: 0, looseness: 0, ignorespaces: 0,
  xspace: 0, color: 1,
  // Front matter, shown in the title block at \maketitle.
  title: 1, author: 1, affiliation: 1, additionalaffiliation: 1, email: 1, orcid: 1, authornote: 1, authornotemark: 0, correspondingauthor: 0, date: 1,
  thanks: 1, subtitle: 1, shortauthors: 0, received: 1, acmJournal: 1, acmVolume: 1, acmNumber: 1, acmArticle: 1, acmYear: 1,
  acmMonth: 1, acmDOI: 1, acmISBN: 1, acmPrice: 1, acmSubmissionID: 1, copyrightyear: 1, setcopyright: 1, settopmatter: 1,
};
/** Named colors `\textcolor` may use; others keep the text's color. */
const TEXT_COLORS = new Set(["red", "green", "blue", "cyan", "magenta", "yellow", "orange", "purple", "violet", "brown", "teal", "olive", "gray", "darkgray", "lightgray", "pink", "lime"]);
const REFS = new Set(["ref", "eqref", "cref", "Cref", "autoref", "pageref", "vref", "nameref", "Autoref", "crefrange"]);
const CITES = new Set(["cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "parencite", "textcite", "autocite",
  "footcite", "Citet", "Citep", "fullcite", "supercite"]);
const ACCENTS: Record<string, string> = { "'": "́", "`": "̀", "^": "̂", '"': "̈", "~": "̃", "=": "̄",
  ".": "̇", u: "̆", v: "̌", H: "̋", c: "̧", k: "̨", r: "̊", d: "̣", b: "̱" };

/**
 * Pseudocode statements (algpseudocode/algorithmicx, and the older algorithmic
 * package's uppercase names). `open`/`close` indent and dedent the lines after
 * and at the statement; `args` are its braced arguments.
 */
type Statement = { before?: string; after?: string; args?: number; open?: boolean; close?: boolean; unnumbered?: boolean; call?: boolean };
const STATEMENTS: Record<string, Statement> = {
  State: {}, Statex: { unnumbered: true },
  Require: { before: "Require:", unnumbered: true }, Ensure: { before: "Ensure:", unnumbered: true },
  Input: { before: "Input:", unnumbered: true }, Output: { before: "Output:", unnumbered: true },
  If: { before: "if", after: "then", args: 1, open: true }, ElsIf: { before: "else if", after: "then", args: 1, close: true, open: true },
  Else: { before: "else", close: true, open: true }, EndIf: { before: "end if", close: true },
  For: { before: "for", after: "do", args: 1, open: true }, ForAll: { before: "for all", after: "do", args: 1, open: true }, EndFor: { before: "end for", close: true },
  While: { before: "while", after: "do", args: 1, open: true }, EndWhile: { before: "end while", close: true },
  Repeat: { before: "repeat", open: true }, Until: { before: "until", args: 1, close: true },
  Loop: { before: "loop", open: true }, EndLoop: { before: "end loop", close: true },
  Function: { before: "function", args: 2, call: true, open: true }, EndFunction: { before: "end function", close: true },
  Procedure: { before: "procedure", args: 2, call: true, open: true }, EndProcedure: { before: "end procedure", close: true },
};
const OLD_STATEMENTS: Record<string, string> = {
  STATE: "State", REQUIRE: "Require", ENSURE: "Ensure", IF: "If", ELSIF: "ElsIf", ELSE: "Else", ENDIF: "EndIf", FOR: "For",
  FORALL: "ForAll", ENDFOR: "EndFor", WHILE: "While", ENDWHILE: "EndWhile", REPEAT: "Repeat", UNTIL: "Until", LOOP: "Loop", ENDLOOP: "EndLoop",
};
/** Keywords used inside a statement. */
const ALGO_WORDS: Record<string, string> = {
  Return: "return", RETURN: "return", PRINT: "print", And: "and", AND: "and", Or: "or", OR: "or", Not: "not", NOT: "not",
  True: "true", TRUE: "true", False: "false", FALSE: "false", To: "to", TO: "to",
};

type Group = { start: number; end: number; next: number };

type TableColumn = { align: "left" | "center" | "right"; wrap?: boolean; share?: number };
type TableCell = { html: string; span: number; align?: TableColumn["align"] };
type TableRow = { start: number; end: number; cells: TableCell[]; above?: "top" | "mid"; under: [number, number][] };
const TABLE_RULES = /\\(?:hline|toprule|midrule|bottomrule|endhead|endfirsthead|endfoot)\b|\\c(?:line|midrule)(?:\([^)]*\))?\{[^}]*\}/g;
const BALANCED = String.raw`(?:[^{}]|\{[^{}]*\})*`;

/** Columns of a tabular spec: alignment, and for paragraph columns a width as a share of the line. */
function tableColumns(spec: string): TableColumn[] {
  const repeat = new RegExp(String.raw`\*\s*\{(\d+)\}\s*\{(${BALANCED})\}`);
  for (let m; (m = repeat.exec(spec));) spec = spec.slice(0, m.index) + m[2].repeat(Number(m[1])) + spec.slice(m.index + m[0].length);
  spec = spec.replace(new RegExp(String.raw`[@!<>]\s*\{${BALANCED}\}|\[[^\]]*\]`, "g"), "");
  const columns: TableColumn[] = [];
  for (const m of spec.matchAll(new RegExp(String.raw`([lcrSX])|([pmb])\s*\{(${BALANCED})\}`, "g"))) {
    if (m[1]) { columns.push({ align: m[1] === "c" ? "center" : m[1] === "r" || m[1] === "S" ? "right" : "left", wrap: m[1] === "X" }); continue; }
    const share = /^\s*([\d.]*)\s*\\(?:columnwidth|textwidth|linewidth|hsize)/.exec(m[3]);
    columns.push({ align: "left", wrap: true, share: share ? Number(share[1] || 1) : undefined });
  }
  return columns;
}

class TexReader {
  private labels = new Map<string, string>();
  private counters: Record<string, number> = {};
  private equation = 0;
  private lastTarget = "";
  private macros: Macros = {};
  /** The same definitions for running text: argument count and the optional argument's default. */
  private textMacros: Record<string, { args: number; optional?: string; body: string }> = {};
  /** How deep in macro expansions this reader is; stops definitions that expand to themselves. */
  private depth = 0;
  /** Preamble lines that pictures need: libraries, styles, colors, macros. */
  private tikzPreamble = "";
  private meta: Record<string, string> = {};
  /** Authors in the ACM style, each with an affiliation and an email. */
  private authors: { name: string; affiliation: string[]; email?: string }[] = [];
  /** Inside pseudocode, where \Return, \Comment and \Call mean something. */
  private pseudocode = false;
  /** A statement's `\\Comment`s, set aside to float at the line's right. */
  private comments: string[] = [];

  constructor(private src: string) {}

  // ── Lexing helpers ──

  /** Skip spaces (and at most one newline unless `lines`). */
  private skipSpace(at: number, lines = false): number {
    let newlines = 0;
    while (at < this.src.length && /\s/.test(this.src[at])) {
      if (this.src[at] === "\n" && ++newlines > 1 && !lines) break;
      at++;
    }
    return at;
  }

  /** A balanced `{…}` (or `[…]`) group starting at `at` after optional spaces. */
  group(at: number, open = "{"): Group | null {
    const close = open === "{" ? "}" : "]";
    let i = this.skipSpace(at);
    if (this.src[i] !== open) return null;
    const start = i + 1;
    let depth = 0;
    for (i = start; i < this.src.length; i++) {
      const ch = this.src[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "%") { i = this.lineEnd(i); continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { if (depth === 0 && close === "}") return { start, end: i, next: i + 1 }; depth--; }
      else if (ch === close && depth === 0) return { start, end: i, next: i + 1 };
    }
    return null;
  }

  private lineEnd(at: number) { const n = this.src.indexOf("\n", at); return n < 0 ? this.src.length : n; }

  /** Command name at `at` (which holds a backslash). */
  private command(at: number): { name: string; next: number } {
    const letters = /^[A-Za-z@]+\*?/.exec(this.src.slice(at + 1, at + 64));
    if (letters) return { name: letters[0], next: at + 1 + letters[0].length };
    return { name: this.src[at + 1] ?? "", next: at + 2 };
  }

  /** Position of the `\end{name}` matching a `\begin{name}` whose body starts at `from`. */
  private envEnd(name: string, from: number, limit: number): { bodyEnd: number; next: number } | null {
    const pattern = /\\(begin|end)\s*\{([^{}]+)\}|%[^\n]*/g;
    pattern.lastIndex = from;
    let depth = 0, match: RegExpExecArray | null;
    while ((match = pattern.exec(this.src)) && match.index < limit) {
      if (!match[1] || match[2] !== name) continue;
      if (VERBATIM_ENVS.has(name) && match[1] === "begin") continue;
      if (match[1] === "begin") depth++;
      else if (depth-- === 0) return { bodyEnd: match.index, next: match.index + match[0].length };
    }
    return null;
  }

  private text(group: Group | null) { return group ? this.src.slice(group.start, group.end) : ""; }
  private attrs(start: number, end: number, cls = "") {
    return ` class="md-block${cls ? " " + cls : ""}" data-offset-start="${start}" data-offset-end="${Math.max(end, start + 1)}"`;
  }
  private count(name: string, reset: string[] = []) {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
    for (const r of reset) this.counters[r] = 0;
    return this.counters[name];
  }

  // ── Document ──

  render(): string {
    const src = this.src;
    this.readMacros(src);
    const begin = /\\begin\s*\{document\}/.exec(src);
    this.tikzPreamble = this.pictureSetup(begin ? begin.index : src.length);
    let from = 0, to = src.length, head = "";
    if (begin) {
      from = begin.index + begin[0].length;
      const end = src.lastIndexOf("\\end{document}");
      if (end > from) to = end;
      const maketitle = /\\maketitle(?![A-Za-z])/.exec(src.slice(from));
      this.frontMatter(maketitle ? from + maketitle.index : begin.index);
      const lines = src.slice(0, begin.index).split("\n").length;
      head = `<p class="tex-preamble">Preamble (lines 1–${lines}) is hidden — see Source.</p>\n`;
    }
    const html = head + this.blocks(from, to);
    // References can point forward, so they are resolved last.
    return html.replace(/\u0000REF:([^\u0000]*)\u0000/g, (_, key: string) => {
      const [kind, label] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const number = this.labels.get(label);
      const shown = number ? (kind === "eqref" ? `(${number})` : number) : label;
      return `<span class="tex-ref${number ? "" : " unknown"}" title="${escapeHtml(label)}">${escapeHtml(shown)}</span>`;
    });
  }

  /** `\newcommand`, `\renewcommand`, `\def` and `\DeclareMathOperator`, for KaTeX and for running text. */
  private readMacros(src: string) {
    const pattern = /\\(?:re|provide|new)command\*?\s*\{?\s*(\\[A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?(?:\s*\[([^\]]*)\])?\s*\{|\\def\s*(\\[A-Za-z@]+)\s*((?:#\d)*)\s*\{|\\DeclareMathOperator(\*?)\s*\{\s*(\\[A-Za-z@]+)\s*\}\s*\{/g;
    for (const match of src.matchAll(pattern)) {
      const body = this.text(this.group(match.index! + match[0].length - 1));
      if (match[1]) {
        this.macros[match[1]] = body;
        this.textMacros[match[1].slice(1)] = { args: Number(match[2] ?? 0), optional: match[3], body };
      } else if (match[4]) {
        this.macros[match[4]] = body;
        this.textMacros[match[4].slice(1)] = { args: match[5].length / 2, body };
      } else if (match[7]) this.macros[match[7]] = `\\operatorname${match[6] ? "*" : ""}{${body}}`;
    }
  }

  /** The preamble commands a standalone picture needs, in document order. */
  private pictureSetup(end: number): string {
    const src = this.src;
    const pattern = /\\(usetikzlibrary|usepgfplotslibrary|tikzset|pgfplotsset|definecolor|colorlet|newcommand|renewcommand|providecommand|DeclareMathOperator|tikzstyle|usepackage|def)(?![A-Za-z])|(?<!\\)%[^\n]*/g;
    const parts: string[] = [];
    for (let match; (match = pattern.exec(src)) && match.index < end;) {
      if (!match[1]) continue;
      let at = match.index + match[0].length;
      if (src[at] === "*") at++;
      // `\def\x#1{…}` and `\newcommand\x{…}` name the macro without braces.
      const bare = /^\s*\\[A-Za-z@]+(#\d)*/.exec(src.slice(at, at + 80));
      if (bare && (match[1] === "def" || /command$|Operator$/.test(match[1]))) at += bare[0].length;
      const argsFrom = at;
      for (let n = 0; n < 4; n++) {
        const spaced = this.skipSpace(at);
        const open = src[spaced] === "=" && match[1] === "tikzstyle" ? src[this.skipSpace(spaced + 1)] : src[spaced];
        if (open !== "{" && open !== "[") break;
        const group = this.group(src[spaced] === "=" ? spaced + 1 : at, open);
        if (!group) break;
        at = group.next;
      }
      if (at === argsFrom && match[1] !== "def") continue; // incomplete
      let text = src.slice(match.index, at);
      if (match[1] === "usepackage") {
        const names = /\{([^}]*)\}\s*$/.exec(text)?.[1].split(",").map(n => n.trim()).filter(n => TIKZ_PACKAGES.has(n)) ?? [];
        if (!names.length) continue;
        text = text.replace(/\{[^}]*\}\s*$/, `{${names.join(",")}}`);
      }
      // A picture's document starts without the article's definitions.
      if (match[1] === "newcommand" || match[1] === "renewcommand") text = text.replace(/^\\(re)?newcommand/, "\\providecommand");
      if (match[1] === "DeclareMathOperator" && !parts.some(p => p.includes("amsmath"))) parts.push("\\usepackage{amsmath}");
      parts.push(text);
      pattern.lastIndex = at;
    }
    return parts.join("\n");
  }

  /** A TikZ picture as an atomic, compiled figure. */
  private picture(name: string, start: number, next: number): string {
    const needs = TIKZ_ENVS[name] && !this.tikzPreamble.includes(TIKZ_ENVS[name]) ? `\\usepackage{${TIKZ_ENVS[name]}}\n` : "";
    return tikzHtml(this.src.slice(start, next), needs + this.tikzPreamble);
  }

  // ── Blocks ──

  private blocks(from: number, to: number): string {
    const src = this.src;
    let out = "", at = from;
    while (at < to) {
      at = this.skipSpace(at, true);
      if (at >= to) break;
      if (src[at] === "%") { at = this.lineEnd(at) + 1; continue; }
      if (src[at] === "\\") {
        const { name, next } = this.command(at);
        if (name === "begin") {
          const env = this.group(next);
          const envName = this.text(env).trim();
          if (env && envName !== "math") {
            const block = this.environment(envName, at, env.next, to);
            if (block) { out += block.html; at = block.next; continue; }
          }
        }
        const level = SECTIONS.indexOf(name.replace(/\*$/, ""));
        if (level >= 0) { const block = this.heading(name, level, at, next); out += block.html; at = block.next; continue; }
        if (name === "maketitle") { out += this.title(at, next); at = next; continue; }
        if (name === "item") { const end = this.paragraphEnd(next, to); out += `<p${this.attrs(at, end)}>${this.inline(next, end)}</p>\n`; at = end; continue; }
        if (name === "bibliography" || name === "printbibliography") {
          const group = name === "bibliography" ? this.group(next) : null;
          const end = group?.next ?? next;
          out += `<p${this.attrs(at, end, "tex-muted")}>${escapeHtml(src.slice(at, end))}</p>\n`;
          at = end; continue;
        }
      }
      const end = this.paragraphEnd(at, to);
      const html = this.inline(at, end).trim();
      if (html) out += `<p${this.attrs(at, end)}>${html}</p>\n`;
      at = Math.max(end, at + 1);
    }
    return out;
  }

  /** A paragraph ends at a blank line, an environment (except inline `math`), a section or an item. */
  private paragraphEnd(from: number, to: number): number {
    const pattern = /\n[ \t]*\n|\\begin\s*\{([^{}]+)\}|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|item|maketitle|bibliography|printbibliography)(?![A-Za-z])|\\.|(?<!\\)%[^\n]*|[{}]/g;
    pattern.lastIndex = from;
    let match: RegExpExecArray | null, depth = 0;
    while ((match = pattern.exec(this.src)) && match.index < to) {
      if (match[0] === "{") { depth++; continue; }
      if (match[0] === "}") { depth = Math.max(0, depth - 1); continue; }
      // Inside a group (e.g. \resizebox{…}{…}{\begin{tikzpicture}…}) the paragraph goes on.
      if (depth > 0 || match.index === from || match[0].startsWith("%") || (match[0].length === 2 && match[0][0] === "\\")) continue;
      if (match[1] === "math") continue;
      return match.index;
    }
    return to;
  }

  private heading(name: string, level: number, start: number, next: number) {
    const starred = name.endsWith("*");
    next = this.group(next, "[")?.next ?? next; // short title
    const title = this.group(next);
    const end = title?.next ?? next;
    let number = "";
    if (!starred && level <= 4) {
      const kinds = SECTIONS.slice(0, 5);
      this.count(kinds[level], kinds.slice(level + 1));
      const parts: number[] = [];
      for (let l = this.counters.chapter ? 1 : 2; l <= level; l++) parts.push(this.counters[kinds[l]] ?? 0);
      number = level === 0 ? this.romanOf(this.counters.part) : level === 1 ? String(this.counters.chapter) : parts.join(".");
      this.lastTarget = number;
    }
    const tag = `h${Math.min(6, Math.max(1, level))}`;
    const body = title ? this.inline(title.start, title.end) : "";
    return { html: `<${tag}${this.attrs(start, end)}>${number ? `<span class="tex-num">${number}</span>` : ""}${body}</${tag}>\n`, next: end };
  }

  private romanOf(n = 1) { return ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] ?? String(n); }

  /** Title, date and authors from the preamble and the body before `\maketitle` (where ACM puts them). */
  private frontMatter(end: number) {
    const src = this.src;
    const pattern = /\\(title|subtitle|date|author|affiliation|email)\s*(?:\[[^\]]*\])?\s*\{|(?<!\\)%[^\n]*/g;
    for (let match; (match = pattern.exec(src));) {
      if (match.index >= end) break;
      if (!match[1]) continue;
      const group = this.group(match.index + match[0].length - 1);
      if (!group) continue;
      pattern.lastIndex = group.next;
      const value = this.text(group), key = match[1];
      if (key === "author") { this.authors.push({ name: value, affiliation: [] }); if (!this.meta.author) this.meta.author = value; }
      else if (key === "affiliation" && this.authors.length) {
        const fields = [...value.matchAll(/\\(institution|department|city|state|country)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].map(m => m[2]);
        // An affiliation belongs to every author since the last one that had its own.
        const place = fields.join(", ") || value, last = this.authors.length - 1;
        let first = last;
        while (first > 0 && !this.authors[first - 1].affiliation.length) first--;
        for (const author of this.authors.slice(this.authors[last].affiliation.length ? last : first)) author.affiliation.push(place);
      } else if (key === "email" && this.authors.length) this.authors.at(-1)!.email = value;
      else if (key !== "author" && !this.meta[key]) this.meta[key] = value;
    }
  }

  private title(start: number, end: number) {
    const part = (key: string, cls: string) => this.meta[key] ? `<div class="${cls}">${this.fragment(this.meta[key])}</div>` : "";
    if (!this.meta.title && !this.meta.author) return "";
    const cards = this.authors.some(a => a.affiliation.length || a.email);
    const authors = cards
      ? `<div class="tex-title-authors">${this.authors.map(a => `<div class="tex-author"><div class="tex-author-name">${this.fragment(a.name)}</div>${a.affiliation.map(f => `<div>${this.fragment(f)}</div>`).join("")}${a.email ? `<div class="tex-author-email">${escapeHtml(a.email)}</div>` : ""}</div>`).join("")}</div>`
      : part("author", "tex-title-author");
    return `<header${this.attrs(start, end, "tex-title")}>${part("title", "tex-title-main")}${part("subtitle", "tex-title-sub")}${authors}${part("date", "tex-title-date")}</header>\n`;
  }

  /** Inline-render a string that is not at a known offset (title, author). */
  private fragment(text: string) { return new TexReader(text).inlineAll(this); }
  inlineAll(parent: TexReader, depth = parent.depth) {
    this.labels = parent.labels; this.macros = parent.macros; this.textMacros = parent.textMacros; this.depth = depth;
    return this.inline(0, this.src.length);
  }

  // ── Environments ──

  private environment(name: string, start: number, bodyStart: number, limit: number): { html: string; next: number } | null {
    const end = this.envEnd(name, bodyStart, limit);
    if (!end) return null;
    const { bodyEnd, next } = end;
    const body = this.src.slice(bodyStart, bodyEnd);
    const attrs = this.attrs(start, next);

    if (name in TIKZ_ENVS) return { html: `<div${this.attrs(start, next, "np-tikz-block")}>${this.picture(name, start, next)}</div>\n`, next };
    if (MATH_ENVS.has(name)) return { html: `<div${this.attrs(start, next, "np-math-block")}>${this.displayMath(name, this.src.slice(start, next), body)}</div>\n`, next };
    if (VERBATIM_ENVS.has(name)) {
      if (HIDDEN_ENVS.has(name)) return { html: "", next };
      let code = body;
      const options = /^\s*(\[[^\]\n]*\])?\s*(\{[^}\n]*\})?[ \t]*\n?/.exec(code);
      if (options) code = code.slice(options[0].length);
      const language = name === "minted" ? options?.[2]?.slice(1, -1) ?? null : null;
      return { html: codeBlock(code.replace(/\n$/, ""), language, language ?? "", attrs), next };
    }
    if (name === "algorithmic") return { html: this.algorithmic(bodyStart, bodyEnd), next };
    if (name in LIST_ENVS) return { html: this.list(name, start, bodyStart, bodyEnd, next), next };
    if (/^(tabular|tabularx|longtable)\*?$/.test(name)) return { html: this.table(start, bodyStart, bodyEnd, next, name), next };
    const plain = name.replace(/\*$/, "");
    if (THEOREMS.has(plain) || name === "proof") {
      const option = this.group(bodyStart, "[");
      const inner = option ? option.next : bodyStart;
      const label = plain[0].toUpperCase() + plain.slice(1);
      let head = name === "proof" ? "Proof" : label;
      if (name !== "proof" && !name.endsWith("*")) { const n = this.count("theorem"); head += ` ${n}`; this.lastTarget = String(n); }
      const title = option ? ` <span class="tex-env-title">(${this.inline(option.start, option.end)})</span>` : "";
      return { html: `<div class="tex-env tex-${name === "proof" ? "proof" : "theorem"}"><div class="tex-env-head">${head}.${title}</div>${this.blocks(inner, bodyEnd)}</div>\n`, next };
    }
    if (QUOTES.has(name)) return { html: `<blockquote>${this.blocks(bodyStart, bodyEnd)}</blockquote>\n`, next };
    if (name === "abstract") return { html: `<div class="tex-env tex-abstract"><div class="tex-env-head">Abstract</div>${this.blocks(bodyStart, bodyEnd)}</div>\n`, next };
    if (name in FLOATS) return { html: this.float(name, bodyStart, bodyEnd), next };
    if (TRANSPARENT.has(name)) return { html: this.blocks(this.group(bodyStart, "[")?.next ?? bodyStart, bodyEnd), next };
    // Unknown environment: its content, under a quiet label.
    return { html: `<div class="tex-env tex-unknown"><div class="tex-env-head">${escapeHtml(name)}</div>${this.blocks(bodyStart, bodyEnd)}</div>\n`, next };
  }

  /** Numbered display math: numbering and labels are done here, KaTeX gets `\tag`s. */
  private displayMath(name: string, source: string, body: string): string {
    const plain = name.replace(/\*$/, "");
    const numbered = !name.endsWith("*") && plain !== "displaymath" && plain !== "math";
    const tagRow = (row: string) => {
      const labels = [...row.matchAll(/\\label\s*\{([^{}]*)\}/g)].map(m => m[1]);
      if (/\\(nonumber|notag)\b/.test(row)) return row.replace(/\\(nonumber|notag)\b/g, "");
      if (!numbered) return row;
      const own = /\\tag\*?\s*\{([^{}]*)\}/.exec(row);
      const number = own ? own[1] : String(++this.equation);
      for (const label of labels) this.labels.set(label, number);
      return own ? row : row + ` \\tag{${number}}`;
    };
    let tex: string;
    if (plain === "equation" || plain === "displaymath" || plain === "math") tex = tagRow(body);
    else if (plain === "multline") tex = `\\begin{gathered}${body.replace(/\\label\s*\{[^{}]*\}/g, "")}\\end{gathered}` + (numbered ? ` \\tag{${this.labelAll(body)}}` : "");
    else {
      const rows = this.splitRows(body).map(row => plain === "eqnarray" ? this.dropSecondAmpersand(row) : row);
      const target = plain === "gather" ? "gather*" : plain === "alignat" ? "alignat*" : "align*";
      const argument = plain === "alignat" ? (/^\s*\{\d+\}/.exec(body)?.[0] ?? "{2}") : "";
      if (argument) rows[0] = rows[0].replace(/^\s*\{\d+\}/, "");
      tex = `\\begin{${target}}${argument}${rows.map(tagRow).join("\\\\")}\\end{${target}}`;
    }
    return mathHtml(source, tex, true, this.macros);
  }

  private labelAll(body: string) {
    const number = String(++this.equation);
    for (const m of body.matchAll(/\\label\s*\{([^{}]*)\}/g)) this.labels.set(m[1], number);
    return number;
  }

  /** Split on top-level `\\` (not inside braces or nested environments). */
  private splitRows(body: string): string[] {
    const rows: string[] = [];
    let depth = 0, env = 0, last = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "\\") {
        if (body.startsWith("\\begin", i)) env++;
        else if (body.startsWith("\\end", i)) env--;
        else if (body[i + 1] === "\\" && depth === 0 && env === 0) { rows.push(body.slice(last, i)); last = i + 2; }
        i++; continue;
      }
      if (ch === "{") depth++; else if (ch === "}") depth--;
    }
    rows.push(body.slice(last));
    return rows;
  }

  private dropSecondAmpersand(row: string) {
    let seen = 0;
    return row.replace(/(?<!\\)&/g, amp => (++seen === 2 ? "" : amp));
  }

  private list(name: string, start: number, bodyStart: number, bodyEnd: number, next: number): string {
    const tag = LIST_ENVS[name] === "dl" ? "ul" : LIST_ENVS[name];
    const items = this.items(bodyStart, bodyEnd);
    let out = `<${tag}${this.attrs(start, next)}${tag === "ul" && name === "description" ? ' data-description=""' : ""}>`;
    for (const item of items) {
      let from = item.contentStart, term = "";
      const option = this.group(from, "[");
      if (option && this.src.slice(from, option.start - 1).trim() === "") { term = this.inline(option.start, option.end); from = option.next; }
      if (name === "enumerate") this.lastTarget = String(items.indexOf(item) + 1);
      const body = this.blocks(from, item.end);
      const single = /^<p class="md-block"[^>]*>([\s\S]*)<\/p>\n$/.exec(body);
      const content = single && !single[1].includes("<p") ? single[1] : body;
      const attrs = single ? this.attrs(item.start, item.end) : "";
      out += `<li${attrs}>${term ? `<strong>${term}</strong> ` : ""}${content}</li>`;
    }
    return out + `</${tag}>\n`;
  }

  /** Top-level `\item`s between `from` and `to`. */
  private items(from: number, to: number) {
    const found: { start: number; contentStart: number; end: number }[] = [];
    const pattern = /\\item(?![A-Za-z])|\\(begin|end)\s*\{([^{}]+)\}|%[^\n]*/g;
    pattern.lastIndex = from;
    let depth = 0, match: RegExpExecArray | null;
    while ((match = pattern.exec(this.src)) && match.index < to) {
      if (match[1] === "begin") depth++;
      else if (match[1] === "end") depth--;
      else if (match[0] === "\\item" && depth === 0) {
        if (found.length) found.at(-1)!.end = match.index;
        found.push({ start: match.index, contentStart: match.index + 5, end: to });
      }
    }
    return found;
  }

  private table(start: number, bodyStart: number, bodyEnd: number, next: number, name: string): string {
    let from = bodyStart;
    if (name.startsWith("tabularx")) from = this.group(from)?.next ?? from;
    from = this.group(from, "[")?.next ?? from;
    const spec = this.group(from);
    from = spec?.next ?? from;
    const columns = tableColumns(this.text(spec));
    const rows: TableRow[] = [];
    let offset = from, pending: string[] = [];
    for (let row of this.splitRows(this.src.slice(from, bodyEnd))) {
      let rowStart = offset;
      offset += row.length + 2;
      const spacing = /^\s*\[[^\]\n]*\]/.exec(row); // \\[2pt]
      if (spacing) { rowStart += spacing[0].length; row = row.slice(spacing[0].length); }
      const leading = new RegExp(`^(?:\\s|${TABLE_RULES.source})*`).exec(row)![0]; // rules before the first cell
      pending.push(...leading.match(TABLE_RULES) ?? []);
      rowStart += leading.length; row = row.slice(leading.length);
      if (!row.trim()) continue;
      // A \cmidrule{a-b} is drawn under the row before it.
      for (const rule of pending) {
        const range = /^\\c(?:line|midrule)[^{]*\{(\d+)(?:-(\d+))?\}/.exec(rule);
        if (range && rows.length) rows.at(-1)!.under.push([Number(range[1]), Number(range[2] ?? range[1])]);
      }
      const above = pending.some(r => r === "\\toprule") ? "top" : pending.some(r => /^\\(midrule|hline)$/.test(r)) ? "mid" : undefined;
      pending = [];
      const cells: TableCell[] = [];
      let cellStart = rowStart, depth = 0;
      for (let i = rowStart; i <= rowStart + row.length; i++) {
        const ch = i === rowStart + row.length ? "&" : this.src[i];
        if (ch === "\\") { i++; continue; }
        if (ch === "{") depth++; else if (ch === "}") depth--;
        if (ch === "&" && depth <= 0) {
          cells.push(this.tableCell(cellStart, i));
          cellStart = i + 1;
        }
      }
      rows.push({ start: rowStart, end: rowStart + row.length, cells, above, under: [] });
    }
    const below = pending.some(r => /^\\(bottomrule|hline)$/.test(r));
    // Rows above the first \midrule are the header.
    const head = rows.findIndex((row, i) => i > 0 && row.above === "mid");
    const html = (row: TableRow, i: number, tag: string) => {
      const cls = [row.above && "rule-" + row.above, below && i === rows.length - 1 && "rule-bottom"].filter(Boolean).join(" ");
      let column = 1;
      const cells = row.cells.map(cell => {
        const first = column, kind = cell.span === 1 ? columns[first - 1] : undefined;
        column += cell.span;
        const align = cell.align ?? columns[first - 1]?.align;
        const under = row.under.some(([a, b]) => first <= b && column - 1 >= a);
        const classes = [kind?.wrap && "wrap", under && "rule-under"].filter(Boolean).join(" ");
        const style = [align && align !== "left" && `text-align:${align}`, kind?.share && `--share:${kind.share}`].filter(Boolean).join(";");
        return `<${tag}${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${classes ? ` class="${classes}"` : ""}${style ? ` style="${style}"` : ""}>${cell.html}</${tag}>`;
      });
      return `<tr${this.attrs(row.start, row.end, cls)}>${cells.join("")}</tr>`;
    };
    const thead = head > 0 ? `<thead>${rows.slice(0, head).map((row, i) => html(row, i, "th")).join("")}</thead>` : "";
    const tbody = rows.slice(Math.max(head, 0)).map((row, i) => html(row, i + Math.max(head, 0), "td")).join("");
    const full = columns.some(c => c.share) ? " full" : "";
    return `<table class="tex-table${full}">${thead}<tbody>${tbody}</tbody></table>\n`;
  }

  /** A cell, unwrapping `\multicolumn{n}{spec}{…}` into a spanning cell and `\multirow{n}{w}{…}` into its content. */
  private tableCell(from: number, to: number): TableCell {
    const at = this.skipSpace(from);
    const span = /^\\multi(column|row)\b/.exec(this.src.slice(at, to));
    if (span) {
      const count = this.group(at + span[0].length);
      const option = count && this.group(count.next, "["); // \multirow[t]{n}[…]{w}
      const second = count && this.group(option?.next ?? count.next);
      const body = second && this.group(second.next);
      if (count && second && body && body.next <= to && !this.src.slice(body.next, to).trim()) {
        const html = this.inline(body.start, body.end).replace(/^\s+|\s+$/g, "");
        if (span[1] === "row") return { html, span: 1 };
        return { html, span: Number(this.text(count).trim()) || 1, align: tableColumns(this.text(second))[0]?.align ?? "left" };
      }
    }
    return { html: this.inline(from, to).replace(/^\s+|\s+$/g, ""), span: 1 };
  }

  /** One row per statement, indented by block, numbered as `[n]` asks. */
  private algorithmic(bodyStart: number, bodyEnd: number): string {
    const option = this.group(bodyStart, "[");
    const every = option && !this.src.slice(bodyStart, option.start - 1).trim() ? Number(this.text(option)) || 0 : 0;
    const found: { name: string; start: number; next: number }[] = [];
    const pattern = /\\(begin|end)\s*\{[^{}]+\}|\\([A-Za-z]+)|\\.|%[^\n]*|[{}]/g;
    pattern.lastIndex = option?.next ?? bodyStart;
    let depth = 0, envs = 0, match: RegExpExecArray | null;
    while ((match = pattern.exec(this.src)) && match.index < bodyEnd) {
      if (match[0] === "{") depth++;
      else if (match[0] === "}") depth--;
      else if (match[1]) envs += match[1] === "begin" ? 1 : -1;
      else if (match[2] && depth === 0 && envs === 0) {
        const name = OLD_STATEMENTS[match[2]] ?? match[2];
        if (name in STATEMENTS) found.push({ name, start: match.index, next: match.index + match[0].length });
      }
    }
    let indent = 0, number = 0, html = "";
    this.pseudocode = true;
    found.forEach((statement, i) => {
      const kind = STATEMENTS[statement.name];
      const end = found[i + 1]?.start ?? bodyEnd;
      let at = statement.next;
      if (this.src[this.skipSpace(at)] === "[") at = this.group(at, "[")?.next ?? at;
      const args: string[] = [];
      this.comments = [];
      for (let n = 0; n < (kind.args ?? 0); n++) {
        const group = this.group(at);
        if (!group) break;
        args.push(this.inline(group.start, group.end).trim());
        at = group.next;
      }
      if (kind.close) indent = Math.max(0, indent - 1);
      const head = kind.call ? `<strong>${kind.before}</strong> <span class="tex-sc">${args[0] ?? ""}</span>(${args[1] ?? ""})`
        : [kind.before && `<strong>${kind.before}</strong>`, args[0], kind.after && `<strong>${kind.after}</strong>`].filter(Boolean).join(" ");
      const rest = this.inline(at, end).trim();
      const comments = this.comments.splice(0).join("");
      const numbered = !kind.unnumbered && every > 0 && ++number % every === 0;
      html += `<div${this.attrs(statement.start, end, "tex-algo-line")}${numbered ? ` data-n="${number}"` : ""} style="padding-left: ${indent * 1.4}em">${comments}${[head, rest].filter(Boolean).join(" ")}</div>`;
      if (kind.open) indent++;
    });
    this.pseudocode = false;
    return `<div class="tex-algo${every > 0 ? " numbered" : ""}">${html}</div>\n`;
  }

  private float(name: string, bodyStart: number, bodyEnd: number): string {
    const kind = FLOATS[name];
    const counter = kind.toLowerCase();
    const caption = /\\caption\s*(\[[^\]]*\])?\s*\{/.exec(this.src.slice(bodyStart, bodyEnd));
    let number = "";
    if (caption) { number = String(this.count(counter)); this.lastTarget = number; }
    const body = this.blocks(this.group(bodyStart, "[")?.next ?? bodyStart, bodyEnd);
    return `<div class="tex-float">${body.replace('<span class="tex-caption"', `<span class="tex-caption" data-kind="${kind}${number ? " " + number : ""}:"`)}</div>\n`;
  }

  // ── Inline ──

  inline(from: number, to: number): string {
    const src = this.src;
    let out = "";
    for (let i = from; i < to;) {
      const ch = src[i];
      if (ch === "%") { i = this.lineEnd(i) + 1; while (src[i] === " " || src[i] === "\t") i++; continue; }
      if (ch === "$" || (ch === "\\" && (src[i + 1] === "(" || src[i + 1] === "["))) {
        const math = this.inlineMath(i, to);
        if (math) { out += math.html; i = math.next; continue; }
      }
      if (ch === "\\") { const r = this.inlineCommand(i, to); out += r.html; i = r.next; continue; }
      if (ch === "{" || ch === "}") { i++; continue; }
      if (ch === "~") { out += " "; i++; continue; }
      if (ch === "-" && src.startsWith("---", i)) { out += "—"; i += 3; continue; }
      if (ch === "-" && src.startsWith("--", i)) { out += "–"; i += 2; continue; }
      if (ch === "`" && src[i + 1] === "`") { out += "“"; i += 2; continue; }
      if (ch === "'" && src[i + 1] === "'") { out += "”"; i += 2; continue; }
      if (ch === "`") { out += "‘"; i++; continue; }
      if (ch === "&") { out += " "; i++; continue; }
      out += escapeHtml(ch === "\n" || ch === "\t" ? " " : ch);
      i++;
    }
    return out;
  }

  private inlineMath(at: number, to: number): { html: string; next: number } | null {
    const src = this.src;
    let open: string, close: string;
    if (src.startsWith("$$", at)) { open = close = "$$"; }
    else if (src[at] === "$") { open = close = "$"; }
    else if (src[at + 1] === "(") { open = "\\("; close = "\\)"; }
    else { open = "\\["; close = "\\]"; }
    for (let i = at + open.length; i < to; i++) {
      if (src.startsWith(close, i)) {
        const next = i + close.length;
        const display = open === "$$" || open === "\\[";
        return { html: mathHtml(src.slice(at, next), src.slice(at + open.length, i), display, this.macros), next };
      }
      if (src[i] === "\\") i++;
    }
    return null;
  }

  private inlineCommand(at: number, to: number): { html: string; next: number } {
    const src = this.src;
    const { name, next } = this.command(at);
    const raw = (end: number) => ({ html: `<span class="tex-raw">${escapeHtml(src.slice(at, end))}</span>`, next: end });
    if (name === "\\") { let end = next; const opt = this.group(end, "["); if (opt && src[this.skipSpace(end)] === "[") end = opt.next; return { html: "<br>", next: end }; }
    if ("%$&#_{}".includes(name) && name.length === 1) return { html: escapeHtml(name), next };
    if (name === "," || name === ";" || name === ":" || name === " " || name === "\n") return { html: name === "," ? " " : " ", next };
    if (name === "!" || name === "-" || name === "/" || name === "@") return { html: "", next };
    if (name in ACCENTS) {
      const group = this.group(next);
      const base = group ? src.slice(group.start, group.end) : src[this.skipSpace(next)] ?? "";
      const end = group ? group.next : this.skipSpace(next) + 1;
      return { html: escapeHtml((base.replace(/^\\/, "") + ACCENTS[name]).normalize("NFC")), next: end };
    }
    if (name in FORMAT) {
      const group = this.group(next);
      if (!group) return { html: "", next };
      return { html: FORMAT[name][0] + this.inline(group.start, group.end) + FORMAT[name][1], next: group.next };
    }
    if (this.pseudocode) {
      if (name in ALGO_WORDS) return { html: `<strong>${ALGO_WORDS[name]}</strong>`, next };
      if (name === "Comment" || name === "COMMENT") {
        const group = this.group(next);
        if (group) { this.comments.push(`<span class="tex-algo-comment">▷ ${this.inline(group.start, group.end)}</span>`); return { html: "", next: group.next }; }
      }
      if (name === "Call") {
        const callee = this.group(next), args = callee && this.group(callee.next);
        if (callee && args) return { html: `<span class="tex-sc">${this.inline(callee.start, callee.end)}</span>(${this.inline(args.start, args.end)})`, next: args.next };
      }
    }
    if (name in SYMBOLS) return { html: escapeHtml(SYMBOLS[name]), next: src.startsWith("{}", next) ? next + 2 : next };
    if (name === "label") {
      const group = this.group(next);
      if (group && this.lastTarget) this.labels.set(this.text(group).trim(), this.lastTarget);
      return { html: "", next: group?.next ?? next };
    }
    if (name in DROP) {
      let end = next;
      if (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end;
      for (let n = 0; n < DROP[name]; n++) end = this.group(end)?.next ?? end;
      return { html: "", next: end };
    }
    if (REFS.has(name)) {
      const group = this.group(next);
      if (!group) return raw(next);
      const html = this.text(group).split(",").map(label => `\u0000REF:${name === "eqref" ? "eqref" : "ref"}:${label.trim()}\u0000`).join(", ");
      return { html, next: group.next };
    }
    if (CITES.has(name)) {
      let end = next;
      while (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end + 1;
      const group = this.group(end);
      if (!group) return raw(end);
      const keys = this.text(group).split(",").map(k => k.trim()).filter(Boolean);
      return { html: `<span class="tex-cite">[${escapeHtml(keys.join(", "))}]</span>`, next: group.next };
    }
    if (name === "footnote") {
      const group = this.group(next);
      if (!group) return raw(next);
      return { html: `<span class="tex-footnote">${this.inline(group.start, group.end)}</span>`, next: group.next };
    }
    if (name === "url" || name === "href") {
      const target = this.group(next);
      if (!target) return raw(next);
      const label = name === "href" ? this.group(target.next) : null;
      const url = this.text(target).trim();
      const safe = /^(https?:|mailto:)/i.test(url) ? url : "";
      const text = label ? this.inline(label.start, label.end) : escapeHtml(url);
      return { html: safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${text}</a>` : text, next: (label ?? target).next };
    }
    if (name === "caption") {
      let end = next;
      if (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end;
      const group = this.group(end);
      if (!group) return raw(end);
      return { html: `<span class="tex-caption">${this.inline(group.start, group.end)}</span>`, next: group.next };
    }
    if (name === "includegraphics") {
      let end = next;
      if (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end;
      const group = this.group(end);
      if (!group) return raw(end);
      return { html: `<span class="tex-graphic">${escapeHtml(this.text(group).trim())}</span>`, next: group.next };
    }
    if (name === "verb" || name === "verb*") {
      const delimiter = src[next];
      const close = delimiter ? src.indexOf(delimiter, next + 1) : -1;
      if (close < 0 || close > to) return raw(next);
      return { html: `<code>${escapeHtml(src.slice(next + 1, close))}</code>`, next: close + 1 };
    }
    if (name === "begin") {
      const env = this.group(next);
      const envName = this.text(env).trim();
      const end = env ? this.envEnd(envName, env.next, to) : null;
      if (env && end && envName in TIKZ_ENVS) return { html: this.picture(envName, at, end.next), next: end.next };
      if (env && end && MATH_ENVS.has(envName)) return { html: this.displayMath(envName, src.slice(at, end.next), src.slice(env.next, end.bodyEnd)), next: end.next };
      if (env && end) return raw(end.next);
    }
    // Scaling boxes: only their content matters here.
    if (name === "resizebox" || name === "resizebox*" || name === "scalebox" || name === "adjustbox") {
      let end = next;
      for (let n = 0; n < (name.startsWith("resizebox") ? 2 : 1); n++) end = this.group(end)?.next ?? end;
      if (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end;
      const content = this.group(end);
      if (content) return { html: this.inline(content.start, content.end), next: content.next };
    }
    if (name === "textcolor" || name === "colorbox") {
      let end = next;
      if (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end; // [rgb]{…}: a model we don't draw
      const color = this.group(end), content = color && this.group(color.next);
      if (content) {
        const named = /^\s*([a-z]+)\s*$/i.exec(this.text(color!))?.[1].toLowerCase();
        const style = named && TEXT_COLORS.has(named) ? ` style="--tex-color:${named}"` : "";
        return { html: `<span class="tex-color"${style}>${this.inline(content.start, content.end)}</span>`, next: content.next };
      }
    }
    // Definitions in the body define; they show nothing.
    if (/^(?:(?:re)?newcommand\*?|providecommand\*?|DeclareMathOperator\*?|def)$/.test(name)) {
      let end = next;
      const named = /^\s*(?:\{\s*\\[A-Za-z@]+\s*\}|\\[A-Za-z@]+)(?:#\d)*/.exec(src.slice(end, end + 80));
      if (named) {
        end += named[0].length;
        while (src[this.skipSpace(end)] === "[") end = this.group(end, "[")?.next ?? end + 1;
        const body = this.group(end);
        if (body) return { html: "", next: body.next };
      }
    }
    // The document's own definitions, expanded with their arguments.
    const macro = Object.hasOwn(this.textMacros, name) ? this.textMacros[name] : undefined;
    if (macro && this.depth < 8) {
      const args: string[] = [];
      let end = next;
      if (macro.optional !== undefined) {
        const option = src[this.skipSpace(end)] === "[" ? this.group(end, "[") : null;
        args.push(option ? this.text(option) : macro.optional);
        end = option?.next ?? end;
      }
      while (args.length < macro.args) {
        const group = this.group(end);
        if (!group) break;
        args.push(this.text(group));
        end = group.next;
      }
      if (args.length === macro.args) {
        if (!macro.args && src.startsWith("{}", end)) end += 2;
        const text = macro.body.replace(/#(\d)/g, (whole, n: string) => args[Number(n) - 1] ?? whole);
        return { html: new TexReader(text).inlineAll(this, this.depth + 1), next: end };
      }
    }
    // Unknown: show the command and its arguments as source.
    let end = next;
    for (let n = 0; n < 4; n++) {
      const spaced = this.skipSpace(end);
      if (src[spaced] === "{" || (src[spaced] === "[" && n === 0)) end = this.group(end, src[spaced])?.next ?? end;
      else break;
    }
    return raw(Math.min(end, to));
  }
}

export const isTexPath = (path: string) => /\.(tex|latex|ltx|sty|cls)$/i.test(path) && !/\.(sty|cls)$/i.test(path);

export function renderTex(source: string): string {
  if (!source.trim()) return '<p class="empty">(empty)</p>';
  return new TexReader(source).render();
}
