// Developer preview: a demo session served like the real thing. Ctrl+C to stop.
import { rmSync } from "node:fs";
import { startWorkspace } from "../core/workspace.js";
import { createDemoStore } from "./fixture.js";

const demo = createDemoStore();
const workspace = await startWorkspace(demo.store, {
  name: "Demo",
  deliveryNote: () => "Demo: the notes are printed in this terminal. Nothing is sent anywhere.",
  async deliver(feedback) { console.log("\n──── Done ────\n" + feedback + "\n──────────────"); return "Printed in the demo terminal."; },
}, { demo: true });
console.log(workspace.url);
const stop = () => { workspace.stop(); rmSync(demo.directory, { recursive: true, force: true }); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
