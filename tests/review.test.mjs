import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Review, hash } from '../dist/review.mjs';
const side = (text, uri = 'file:///repo/a.ts') => ({ kind: 'text', uri, text, hash: hash(text) });
const file = (before, after) => ({ id: 'a', path: '/repo/a.ts', before, after });

test('personal checkpoints preserve exactly the viewed version across refresh and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lookout-state-'));
  try {
    const review = await Review.load(dir, 'host/session/chat/scope');
    await review.replace([file(side('original'), side('v1'))], 'Session Changes');
    assert.equal(review.visible('since')[0].before.text, 'original');
    await review.seen('a');
    assert.deepEqual(review.visible('since'), []);
    assert.equal(review.visible('all')[0].after.text, 'v1');
    await review.replace([file(side('original'), side('v2'))], 'Session Changes');
    assert.equal(review.visible('since')[0].before.text, 'v1');
    const restored = await Review.load(dir, 'host/session/chat/scope');
    assert.equal(restored.visible('since')[0].after.text, 'v2');
    const separate = await Review.load(dir, 'host/session/chat/another-scope');
    assert.equal(separate.data.files.length, 0);
  } finally { await rm(dir, { recursive: true }); }
});

test('added, deleted, reverted and metadata-only files retain distinct baselines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lookout-state-'));
  try {
    const review = await Review.load(dir, 'identity');
    await review.replace([file(null, side('added'))], 'Changes'); await review.seen('a');
    await review.replace([file(null, null)], 'Changes');
    assert.equal(review.visible('since')[0].before.text, 'added');
    await review.seen('a'); assert.equal(review.visible('since').length, 0);
    await review.replace([file(side('original'), null)], 'Changes');
    assert.equal(review.visible('all')[0].after, null);
    await review.replace([file(side('original'), side('original'))], 'Changes');
    assert.equal(review.visible('all').length, 0);
    const binary = { uri: 'file:///repo/a.bin', kind: 'binary', hash: 'binary-v1' };
    await review.replace([file(null, binary)], 'Changes'); await review.seen();
    assert.equal(review.visible('since').length, 0);
    await review.replace([file(null, { uri: binary.uri, kind: 'unavailable', hash: '' })], 'Changes');
    await assert.rejects(review.seen('a'), /unavailable/);
  } finally { await rm(dir, { recursive: true }); }
});

test('comments retain quoted context, drafts persist, interrupted delivery becomes uncertain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lookout-state-'));
  try {
    const review = await Review.load(dir, 'identity');
    await review.replace([file(side('before'), side('one\ntwo\nthree\n'))], 'Changes');
    await review.comment({ file: 'a', side: 'after', first: 2, last: 3, text: 'Simplify this' }, 'since');
    assert.match(review.feedback(), /> two\n> three/);
    await review.replace([file(side('before'), side('new text'))], 'Changes');
    assert.match(review.feedback(), /earlier snapshot/);
    review.data.draft = 'My edited feedback';
    review.data.delivery = { id: 'message', text: review.data.draft, state: 'pending' };
    await review.save();
    const restored = await Review.load(dir, 'identity');
    assert.equal(restored.feedback(), 'My edited feedback');
    assert.equal(restored.data.notes[0].quote, 'two\nthree');
    assert.equal(restored.data.delivery.state, 'uncertain');
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally { await rm(dir, { recursive: true }); }
});
