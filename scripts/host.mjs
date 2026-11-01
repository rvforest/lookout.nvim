#!/usr/bin/env node
// Thin standalone composition of ahpd's existing SDK and patched ACP backend.
import './patch-host.mjs';
import { createHost, listen, fileResources, gitChanges, gitBranches, fileSessions } from '@ahpd/sdk';
import { acpAgent } from '@ahpd/agent-acp';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: {
  path: { type: 'string', default: process.cwd() }, port: { type: 'string', default: '9187' },
  state: { type: 'string', default: join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'lookout-host') },
  'token-file': { type: 'string' },
} });
const path = resolve(values.path);
await mkdir(values.state, { recursive: true, mode: 0o700 });
const tokenFile = values['token-file'] ?? join(values.state, 'connection-token');
let token;
try { token = (await readFile(tokenFile, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  token = randomBytes(32).toString('hex');
  await writeFile(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
}
if (!token) throw new Error('Connection token is empty');
const host = createHost({ path,
  agents: [acpAgent({ provider: 'codex', displayName: 'Codex', command: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/@agentclientprotocol/codex-acp/dist/index.js', import.meta.url))],
    hostTools: false, honoursTrust: true })],
  resources: fileResources(), changes: gitChanges(), branches: gitBranches(),
  sessions: fileSessions({ dir: join(values.state, 'sessions'), onProblem: console.error }),
});
const listener = await listen({ port: Number(values.port), host: '127.0.0.1', token }, (peer) => host.accept(peer));
console.log(`Lookout host: ws://127.0.0.1:${listener.port}`);
console.log(`Token file: ${tokenFile}\nRepository: ${path}\nKeep this process running (for example, in tmux).`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await listener.close(); await host.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
