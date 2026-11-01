import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHost, listen, fileResources, gitChanges } from '@ahpd/sdk';
import { acpAgent } from '@ahpd/agent-acp';
import { attach, waitAction } from './host-harness.mjs';
export async function fixture(mode = 'injected') {
  const dir = await mkdtemp(join(tmpdir(), 'lookout-host-'));
  execFileSync('git', ['init', '-q', dir]);
  await writeFile(join(dir, 'sample.ts'), 'export const count = 1;\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Review', '-c', 'user.email=test@localhost', 'commit', '-qm', 'baseline']);
  const host = createHost({ path: dir, resources: fileResources(), changes: gitChanges(),
    agents: [acpAgent({ provider: 'codex', command: process.execPath, args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url)), mode], hostTools: false, honoursTrust: true })] });
  const listener = await listen({ port: 0, host: '127.0.0.1', token: 'fixture-token' }, (peer) => host.accept(peer));
  const creator = await attach(host);
  const session = `codex:/${crypto.randomUUID()}`;
  await creator.client.request('createSession', { channel: session, provider: 'codex', workingDirectories: [pathToFileURL(dir).href] });
  const { result } = await creator.client.subscribe(session);
  const chat = result.snapshot.state.defaultChat;
  await creator.client.subscribe(chat);
  const ready = waitAction(creator.client, (event) => event.action.type === 'chat/delta' || event.action.type === 'chat/error' || event.rejectionReason);
  creator.client.dispatch(chat, { type: 'chat/turnStarted', turnId: crypto.randomUUID(), startedAt: new Date().toISOString(), message: { text: 'Work on the fixture' } });
  assert.equal((await ready).action.type, 'chat/delta');
  await writeFile(join(dir, 'sample.ts'), 'export const count = 2;\n');
  return { dir, host, listener, creator, session, chat,
    endpoint: `ws://127.0.0.1:${listener.port}`,
    close: async () => {
      await creator.close(); await listener.close(); await host.close();
      // The host can finish an asynchronous Git checkpoint just after close.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } };
}
