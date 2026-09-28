import ext from "../index.ts";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

const commands = new Map<string, { description: string; handler: Function }>();
const hooks = new Map<string, Function>();
const sent: string[] = [];
const notifications: string[] = [];

const pi = {
  registerCommand: (name: string, def: { description: string; handler: Function }) => commands.set(name, def),
  on: (event: string, handler: Function) => hooks.set(event, handler),
  exec: async () => ({ code: 0, stderr: "" }),
  sendUserMessage: (msg: string) => sent.push(msg),
};

ext(pi as never);

check("module loads and default export runs", true);
check("/annotate registered", commands.has("annotate"));
check("/annotate-last registered", commands.has("annotate-last"));
check("demo is not a user command", !commands.has("annotate-demo"));
check("turn_end hook registered", hooks.has("turn_end"));
check("/annotate description is English", commands.get("annotate")!.description === "Review session changes or open a file or folder");

const ctx = {
  cwd: "/tmp",
  ui: { notify: (msg: string, level?: string) => notifications.push(`${level ?? "info"}:${msg}`) },
  sessionManager: {
    getBranch: () => [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hello from the assistant" }] } },
    ],
  },
} as never;

// Missing file -> English error, no server started
await commands.get("annotate")!.handler("does-not-exist.md", ctx);
check("missing file reports English error", notifications.some((n) => n.includes("File not found:")));

// Empty args -> workspace requires interactive mode
notifications.length = 0;
await commands.get("annotate")!.handler("  ", ctx);
check("empty args opens session review only in TUI", notifications.some((n) => n.includes("requires interactive Pi")));

// Auto-detect disabled: superpowers paths must stay silent
notifications.length = 0;
await hooks.get("turn_end")!(
  { message: { role: "assistant", content: [{ type: "text", text: "Wrote docs/superpowers/specs/foo.md" }] } },
  ctx,
);
check("auto-detect disabled -> silent turn_end", notifications.length === 0);

console.log(failures === 0 ? "\nEXTENSION SUITE PASSED" : `\n${failures} EXTENSION TEST(S) FAILED`);
process.exit(failures ? 1 : 0);
