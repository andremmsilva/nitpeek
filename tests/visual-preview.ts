// Developer-only local fixture for reviewing the browser UI. No Pi slash command.
import { registerDemo } from '../review-extension.ts';

const hooks = new Map<string, Function>();
let url = '';
const pi = {
  on(name: string, handler: Function) { hooks.set(name, handler); },
  async exec(_command: string, args: string[]) { url = args.at(-1) || ''; return { code: 0 }; },
};
const context = {
  cwd: process.cwd(), mode: 'tui',
  ui: { notify() {} },
  sessionManager: { getSessionId: () => 'visual-preview', getSessionFile: () => null },
};
await registerDemo(pi as any)(context as any);
if (!url) throw new Error('Preview server did not start');
console.log(`Developer preview: ${url}\nCtrl+C removes its temporary fixture.`);
let closed = false;
const stop = () => {
  if (closed) return;
  closed = true;
  hooks.get('session_shutdown')?.();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise<void>(() => {});
