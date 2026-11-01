import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { acpAgent } from '@ahpd/agent-acp';
import { harness, waitAction, attach } from './host-harness.mjs';

for (const mode of ['injected', 'unsupported', 'promptRequired', 'error']) {
  test(`ACP bridge: ${mode}`, { timeout: 20000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lookout-'));
    const agent = acpAgent({ provider: 'codex', command: process.execPath,
      args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url)), mode], hostTools: false, honoursTrust: true });
    const h = await harness({ path: dir, agents: [agent] });
    let observer;
    try {
      const uri = `ahp-session:/${crypto.randomUUID()}`;
      await h.client.request('createSession', { channel: uri, provider: 'codex', workingDirectories: [pathToFileURL(dir).href] });
      const { result } = await h.client.subscribe(uri);
      const chat = result.snapshot.state.defaultChat;
      await h.client.subscribe(chat);
      const ready = waitAction(h.client, (x) => x.action.type === 'chat/delta' || x.rejectionReason || x.action.type === 'chat/error');
      h.client.dispatch(chat, { type: 'chat/turnStarted', turnId: crypto.randomUUID(), startedAt: new Date().toISOString(), message: { text: 'Work' } });
      const opening = await ready;
      assert.equal(opening.action.type, 'chat/delta', JSON.stringify(opening));
      // A second client can attach to the live session without interrupting it.
      observer = await attach(h.host);
      const observed = await observer.client.subscribe(chat);
      assert.ok(observed.result.snapshot.state.activeTurn);
      const outcome = waitAction(h.client, (x) => x.action.type === 'chat/pendingMessageSet');
      const completed = mode === 'injected' ? waitAction(h.client, (x) => x.action.type === 'chat/turnComplete') : undefined;
      h.client.dispatch(chat, { type: 'chat/pendingMessageSet', kind: 'steering', id: 'feedback-1', message: { text: 'Simplify persistence' } });
      const event = await outcome;
      if (mode === 'injected') {
        assert.equal(event.rejectionReason, undefined);
        await completed;
        const { result: current } = await h.client.subscribe(chat);
        const json = JSON.stringify(current.snapshot.state);
        assert.match(json, /Simplify persistence/);
      } else {
        assert.ok(event.rejectionReason);
        assert.match(event.rejectionReason, mode === 'unsupported' ? /advertise steering/ : mode === 'promptRequired' ? /turn ended/i : /Simulated delivery failure/);
        const { result: current } = await h.client.subscribe(chat);
        assert.equal(current.snapshot.state.queuedMessages.length, 0, 'never silently queue');
      }
    } finally { await observer?.close(); await h.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
