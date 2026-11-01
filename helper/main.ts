import { createInterface } from 'node:readline';
import { Controller } from './controller.js';
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const controller = new Controller((event, data) => output({ event, data }));
// Serialize user commands; protocol updates and UI notifications remain live.
let commands = Promise.resolve();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  commands = commands.then(async () => {
    let request: { id: number; method: string; params?: any } | undefined;
    try {
      request = JSON.parse(line); const { method, params = {} } = request!;
      let result: unknown;
      switch (method) {
        case 'connect': result = await controller.connect(params); break;
        case 'sessions': result = await controller.sessions(); break;
        case 'chats': result = await controller.chats(params.session); break;
        case 'changesets': result = await controller.changesets(params.session, params.chat); break;
        case 'select': result = await controller.select(params); break;
        case 'refresh': await controller.refresh(); break;
        case 'view': controller.view(params.mode === 'all' ? 'all' : 'since'); break;
        case 'seen': await controller.seen(params.id); break;
        case 'comment': await controller.comment(params); break;
        case 'draft': await controller.draft(params.text); break;
        case 'feedback': result = controller.feedback(); break;
        case 'clear': await controller.clearNotes(); break;
        case 'send': await controller.send(params.text); break;
        case 'disconnect': await controller.disconnect(); break;
        default: throw new Error(`Unknown helper method: ${method}`);
      }
      output({ id: request!.id, result: result ?? null });
    } catch (error) { output({ id: request?.id, error: error instanceof Error ? error.message : String(error) }); }
  });
}
await commands;
await controller.disconnect();
process.exit(0);
