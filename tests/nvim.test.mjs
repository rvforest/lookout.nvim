import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from './fixture.mjs';
const nvim = process.env.NVIM_BIN ?? 'nvim';
const installed = spawnSync(nvim, ['--version'], { encoding: 'utf8' });
test('Neovim connects, inspects native diffs, comments, sends feedback and restores its workspace', {
  timeout: 30000, skip: installed.error ? 'Set NVIM_BIN to Neovim 0.11+ to run the UI integration test' : false,
}, async () => {
  const f = await fixture();
  const state = await mkdtemp(join(tmpdir(), 'lookout-nvim-'));
  try {
    const output = await new Promise((resolveOutput, reject) => {
      const child = spawn(nvim, ['--headless', '-u', 'NONE', '-i', 'NONE', '-l', 'tests/nvim.lua'], {
        cwd: process.cwd(), env: { ...process.env, LOOKOUT_ROOT: resolve('.'),
          LOOKOUT_TEST_URL: f.endpoint, LOOKOUT_TEST_TOKEN: 'fixture-token', LOOKOUT_TEST_STATE: state,
          XDG_STATE_HOME: state, XDG_CACHE_HOME: state, XDG_DATA_HOME: state, NVIM_LOG_FILE: join(state, 'nvim.log') },
      });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; }); child.stderr.on('data', (chunk) => { text += chunk; });
      child.on('error', reject);
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Neovim timed out\n${text}`)); }, 25000);
      child.on('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(text)); else resolveOutput(text); });
    });
    assert.match(output, /Neovim review flow passed/);
  } finally { await f.close(); await rm(state, { recursive: true, force: true }); }
});
