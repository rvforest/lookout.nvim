// Local compatibility patch for the pinned ahpd 0.14.0 packages. No wire
// changes: await the backend's delivery result before acknowledging a steer.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../node_modules/', import.meta.url));
const marker = 'lookout: async steering bridge';
const bridge = `
        // ${marker}
        steer: async (id, text, attachments) => {
            if (attachments?.length) return 'This steering bridge accepts text feedback only';
            const turn = ctx.active;
            if (!turn) return false;
            const live = ctx.live;
            if (!live || !ctx.mapping?.prompted) return 'The turn is still starting; retry feedback shortly';
            try {
                const hello = await live.initialize();
                if (hello._meta?.steering?.supported !== true)
                    return 'This ACP agent did not advertise steering support';
                if (ctx.active !== turn) return 'The turn ended before feedback was sent; send again as a new turn';
                const result = await live.steer(ctx.acpSessionId, text);
                if (result.outcome !== 'injected')
                    return result.outcome === 'promptRequired'
                        ? 'The turn ended before feedback was injected; send again as a new turn'
                        : 'The ACP agent could not confirm feedback injection';
                emit('chat', { type: 'chat/pendingMessageSet', kind: 'steering', id, message: { text } });
                emit('chat', { type: 'chat/pendingMessageRemoved', kind: 'steering', id });
                return true;
            } catch (error) {
                return 'Steering delivery failed or is uncertain: ' + (error instanceof Error ? error.message : String(error));
            }
        },
`;
const changes = [
  ['@ahpd/agent-acp', 'dist/connection.js', '        cancel: (sessionId)', `        // ${marker}
        steer: (sessionId, text) => heard(() => connection.agent.request('_session/steering', {
            sessionId, prompt: [{ type: 'text', text }],
            _meta: { steering: { idleBehavior: 'promptRequired' } },
        })),
        cancel: (sessionId)`],
  ['@ahpd/agent-acp', 'dist/session.js', '        queue: ctx.queue,', bridge + '        queue: ctx.queue,'],
  ['@ahpd/sdk', 'dist/host/chatactions.js',
    "                if (!session.steer(String(action.id ?? ''), String(message.text ?? ''), steered.attachments)) {\n                    no('Nothing is running in this chat to steer');\n                }",
    `                // ${marker}
                return Promise.resolve(session.steer(String(action.id ?? ''), String(message.text ?? ''), steered.attachments)).then((delivery) => {
                    if (typeof delivery === 'string') no(delivery);
                    else if (!delivery) no('Nothing is running in this chat to steer');
                }, (error) => no(error instanceof Error ? error.message : String(error)));`],
];

// Validate every input before mutating any file; fail visibly on version drift.
const pending = [];
for (const [pkg, file, before, after] of changes) {
  const manifest = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
  if (manifest.version !== '0.14.0') throw new Error(`Unsupported ${pkg} ${manifest.version}; expected 0.14.0`);
  const path = join(root, pkg, file);
  const source = await readFile(path, 'utf8');
  if (source.includes(marker)) continue;
  if (source.split(before).length !== 2) throw new Error(`Patch context changed: ${pkg}/${file}`);
  pending.push([path, source.replace(before, after)]);
}
for (const [path, source] of pending) await writeFile(path, source);
console.log(`ahpd steering bridge: ${pending.length ? 'applied' : 'already applied'}`);
