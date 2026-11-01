import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHost, listen, fileResources, gitChanges } from '@ahpd/sdk';
import { acpAgent } from '@ahpd/agent-acp';
import { attach, waitAction } from './host-harness.mjs';
import { Controller } from '../dist/controller.mjs';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Condition timeout'); await pause(30); }
}
import { fixture } from './fixture.mjs';

test('real WebSocket changesets, snapshots, personal baseline and reconnect', { timeout: 30000 }, async () => {
  const f = await fixture();
  const cache = await mkdtemp(join(tmpdir(), 'lookout-cache-'));
  const events = [];
  const controller = new Controller((event, data) => events.push({ event, data }));
  try {
    await controller.connect({ name: 'test', url: f.endpoint, token: 'fixture-token', stateDir: cache });
    const sessions = await controller.sessions();
    assert.ok(sessions.some((session) => session.resource === f.session), JSON.stringify(sessions));
    await controller.chats(f.session);
    const changesets = await controller.changesets(f.session, f.chat);
    const scope = changesets.find((entry) => entry.changeKind === 'uncommitted');
    assert.ok(scope, JSON.stringify(changesets));
    await controller.select({ session: f.session, chat: f.chat, changeset: scope.uriTemplate, label: scope.label });
    const initial = controller.review.data.files.find((file) => file.path.endsWith('sample.ts'));
    assert.equal(initial.before.text, 'export const count = 1;\n');
    assert.equal(initial.after.text, 'export const count = 2;\n');
    await controller.seen(initial.id);
    await writeFile(join(f.dir, 'sample.ts'), 'export const count = 3;\n');
    await until(() => controller.dirty);
    assert.equal(controller.review.data.files[0].after.text, 'export const count = 2;\n', 'display stays frozen');
    await controller.refresh();
    assert.equal(controller.review.visible('since')[0].before.text, 'export const count = 2;\n');
    assert.equal(controller.review.visible('since')[0].after.text, 'export const count = 3;\n');
    await controller.comment({ file: initial.id, side: 'after', first: 1, last: 1, text: 'Use a constant name' });
    // Disconnect only this client. The host and its independently owned session stay alive.
    await controller.connection.client.shutdown();
    await until(() => controller.status !== 'connected');
    await until(() => controller.status === 'connected');
    assert.equal(controller.review.data.notes.length, 1);
    assert.equal(controller.review.visible('since')[0].after.text, 'export const count = 3;\n');
    // Reverting to HEAD removes the file from the host changeset. The personal
    // baseline must still show the reversal from the marked count=2 version.
    await writeFile(join(f.dir, 'sample.ts'), 'export const count = 1;\n');
    await pause(400);
    await controller.refresh();
    assert.equal(controller.review.visible('since')[0].after.text, 'export const count = 1;\n');
    assert.ok(controller.review.data.files[0].removedFromChangeset);
    assert.ok(events.some((event) => event.event === 'view'));
  } finally { await controller.disconnect(); await f.close(); await rm(cache, { recursive: true, force: true }); }
});

test('controller sends steering once and clears notes only after accepted', { timeout: 20000 }, async () => {
  const f = await fixture();
  const cache = await mkdtemp(join(tmpdir(), 'lookout-cache-'));
  const controller = new Controller(() => {});
  try {
    await controller.connect({ name: 'test', url: f.endpoint, token: 'fixture-token', stateDir: cache });
    await controller.chats(f.session);
    const scopes = await controller.changesets(f.session, f.chat);
    const scope = scopes.find((entry) => entry.changeKind === 'uncommitted');
    assert.ok(scope, JSON.stringify(scopes));
    await controller.select({ session: f.session, chat: f.chat, changeset: scope.uriTemplate, label: scope.label });
    await until(() => controller.connection.states.get(f.chat)?.activeTurn);
    await controller.comment({ text: 'Simplify this' });
    await controller.send(controller.feedback());
    await until(() => controller.review.data.delivery.state !== 'pending');
    assert.equal(controller.review.data.delivery.state, 'accepted');
    assert.equal(controller.review.data.notes.length, 0);
    assert.equal(controller.review.data.draft, '');
  } finally { await controller.disconnect(); await f.close(); await rm(cache, { recursive: true, force: true }); }
});

for (const mode of ['unsupported', 'hold']) test(`feedback ${mode === 'hold' ? 'disconnect' : 'rejection'} preserves the draft`, { timeout: 25000 }, async () => {
  const f = await fixture(mode);
  const cache = await mkdtemp(join(tmpdir(), 'lookout-cache-'));
  const controller = new Controller(() => {});
  try {
    await controller.connect({ name: 'test', url: f.endpoint, token: 'fixture-token', stateDir: cache });
    await controller.chats(f.session);
    const scope = (await controller.changesets(f.session, f.chat)).find((entry) => entry.changeKind === 'uncommitted');
    await controller.select({ session: f.session, chat: f.chat, changeset: scope.uriTemplate, label: scope.label });
    await controller.comment({ text: 'Keep this feedback' });
    await controller.send(controller.feedback());
    if (mode === 'hold') await controller.connection.client.shutdown();
    await until(() => controller.review.data.delivery.state !== 'pending');
    assert.equal(controller.review.data.delivery.state, mode === 'hold' ? 'uncertain' : 'failed');
    assert.equal(controller.review.data.notes.length, 1);
    assert.match(controller.review.data.draft, /Keep this feedback/);
    const originalId = controller.review.data.delivery.id;
    if (mode === 'hold') {
      await until(() => controller.status === 'connected');
      assert.equal(controller.review.data.delivery.id, originalId, 'reconnecting must not resend');
    }
    await controller.disconnect();
    const restored = new Controller(() => {});
    try {
      await restored.connect({ name: 'test', url: f.endpoint, token: 'fixture-token', stateDir: cache });
      assert.match(restored.review.data.draft, /Keep this feedback/);
      assert.equal(restored.review.data.delivery.id, originalId);
    } finally { await restored.disconnect(); }
  } finally { await controller.disconnect(); await f.close(); await rm(cache, { recursive: true, force: true }); }
});

test('binary and oversized files remain metadata-only and deleted additions remain reviewable', { timeout: 20000 }, async () => {
  const f = await fixture();
  const cache = await mkdtemp(join(tmpdir(), 'lookout-cache-'));
  const controller = new Controller(() => {});
  try {
    await writeFile(join(f.dir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(f.dir, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
    await writeFile(join(f.dir, 'added.txt'), 'added\n');
    await controller.connect({ name: 'test', url: f.endpoint, token: 'fixture-token', stateDir: cache });
    await controller.chats(f.session);
    const scope = (await controller.changesets(f.session, f.chat)).find((entry) => entry.changeKind === 'uncommitted');
    await controller.select({ session: f.session, chat: f.chat, changeset: scope.uriTemplate, label: scope.label });
    assert.equal(controller.review.data.files.find((file) => file.path.endsWith('binary.bin')).after.kind, 'binary');
    const large = controller.review.data.files.find((file) => file.path.endsWith('large.txt'));
    assert.equal(large.after.kind, 'large');
    assert.equal(large.after.text, undefined);
    await assert.rejects(controller.seen(large.id), /metadata-only/);
    const added = controller.review.data.files.find((file) => file.path.endsWith('added.txt'));
    await controller.seen(added.id);
    await rm(join(f.dir, 'added.txt'));
    await controller.refresh();
    const reversal = controller.review.visible('since').find((file) => file.id === added.id);
    assert.equal(reversal.after, null);
    assert.equal(reversal.before.text, 'added\n');
    assert.ok(!controller.review.visible('all').some((file) => file.id === added.id), 'all view follows the advertised scope');
  } finally { await controller.disconnect(); await f.close(); await rm(cache, { recursive: true, force: true }); }
});
