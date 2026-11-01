// Opt-in real subscription check. Creates an isolated temporary Git repository.
import './patch-host.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { acpAgent } from '@ahpd/agent-acp';
import { fileResources, gitChanges } from '@ahpd/sdk';
import { harness, waitAction, attach } from '../tests/host-harness.mjs';
const dir = await mkdtemp(join(tmpdir(), 'lookout-live-'));
execFileSync('git', ['init', '-q', dir]);
execFileSync('git', ['-C', dir, '-c', 'user.name=Lookout', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-qm', 'baseline']);
const h = await harness({ path: dir, resources: fileResources(), changes: gitChanges(), agents: [acpAgent({
  provider: 'codex', command: process.execPath,
  args: [fileURLToPath(new URL('../node_modules/@agentclientprotocol/codex-acp/dist/index.js', import.meta.url))],
  hostTools: false, honoursTrust: true,
  env: { INITIAL_AGENT_MODE: 'workspace-write' },
})] });
let observer;
try {
  const uri = `ahp-session:/${crypto.randomUUID()}`;
  await h.client.request('createSession', { channel: uri, provider: 'codex', workingDirectories: [pathToFileURL(dir).href] });
  const { result } = await h.client.subscribe(uri);
  const chat = result.snapshot.state.defaultChat;
  await h.client.subscribe(chat);
  const stream = h.client.events();
  let sent = false;
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Live smoke timed out after 90 seconds')), 90000);
    void (async () => { for await (const { event } of stream) {
      if (event.type !== 'action') continue;
      const { action, rejectionReason } = event.params;
      if (rejectionReason) { clearTimeout(timeout); reject(new Error(rejectionReason)); break; }
      if (action.type === 'chat/error') { clearTimeout(timeout); reject(new Error(action.part.error.message)); break; }
      if (!sent && (action.type === 'chat/delta' || action.type === 'chat/toolCallStart')) {
        sent = true;
        console.log('Sending mid-turn steering');
        h.client.dispatch(chat, { type: 'chat/pendingMessageSet', kind: 'steering', id: 'live-feedback', message: { text: 'Change the required file content to after. Write only after in checkpoint.txt. Do not use shell commands.' } });
      }
      if (action.type === 'chat/pendingMessageSet' && action.id === 'live-feedback') console.log('Host confirmed steering injection');
      if (action.type === 'chat/turnComplete') { clearTimeout(timeout); resolve(); break; }
    } })().catch((e) => { clearTimeout(timeout); reject(e); });
  });
  h.client.dispatch(chat, { type: 'chat/turnStarted', turnId: crypto.randomUUID(), startedAt: new Date().toISOString(), message: {
    text: 'In this temporary repository, write checkpoint.txt containing before. First explain your approach briefly, then write the file using your file-edit tool. Do not use shell commands. A follow-up message may change the content.' } });
  observer = await attach(h.host);
  await observer.client.subscribe(chat);
  await completed;
  console.log('File content:', (await readFile(join(dir, 'checkpoint.txt'), 'utf8')).trim());
  const session = await h.client.subscribe(uri);
  console.log('Advertised changeset kinds:', session.result.snapshot.state.changesets?.map((x) => x.changeKind));
  await stream.return();
} finally { await observer?.close(); await h.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
process.exit(0);
