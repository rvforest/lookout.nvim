# Testing status

The Neovim plugin and Node helper are tested with a scripted agent. The host’s
steering support is provided by a [local patch](host-patch.md).

## Automated tests

- TypeScript checking and standalone helper bundling.
- Actual ahpd SDK, ACP backend, and official AHP client initialization,
  subscriptions, action framing, and steering.
- Success, missing capability, delivery failure, and a turn-ending race,
  without silently queueing feedback.
- Real loopback WebSocket host, token authentication, session discovery,
  filesystem watches, changeset content, and reconnect.
- Frozen snapshots, per-file baselines, a file reverting out of a changeset,
  quoted comments, persistent drafts, and interrupted delivery state.
- Headless Neovim 0.11.5: connection, scope selection, native diffs, range
  comments, feedback acceptance, marking seen, switching baselines, and
  closing/reopening the review while restoring the original tab.
- Standalone host startup and generation of a connection-token file.

## Live Codex limitation here

During development, `codex login status` reported a ChatGPT login, but the adapter
exited before starting a turn because the Codex state directory was read-only.
Moving SQLite state alone does not resolve other required writes. Authentication
files were not copied or changed, and API billing was not substituted.

Real subscription-backed inference, receipt by a real Codex model, and full
Codex/host session recovery remain **unverified**. Run `npm run smoke:live` on
a machine with a normally writable Codex home. A real SSH port forward and the
external ahpc client’s UI were not exercised; remote content access was tested
through the AHP WebSocket boundary without local path reads.

## Versions

| Component | Pinned / exercised |
| --- | --- |
| Node.js | 24.19.0 |
| Neovim | 0.11.5 |
| @ahpd/sdk | 0.14.0, patched |
| @ahpd/agent-acp | 0.14.0, patched |
| @agentclientprotocol/codex-acp | 2.5.0 |
| @microsoft/agent-host-protocol | 1.0.0 |

All npm dependencies, including the adapter’s bundled Codex, are locked.
The launcher composes the SDK and does not modify a global ahpd installation.
