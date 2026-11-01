# lookout.nvim

Follow a Codex session from Neovim, inspect changes when you’re ready, and send
feedback while the agent continues. Marking a file seen records its displayed
content as your personal baseline; it does not commit or approve changes.

**Experimental — the complete workflow with a live Codex agent has not yet been
verified.** Automated tests cover the Neovim interface and AHP communication
using a scripted agent. The live test could not start a Codex turn because the
development environment’s Codex state directory was read-only. Passing CI does
not yet establish that subscription login, steering, and session recovery work
together with a real Codex agent. See [testing status](docs/testing.md).

Lookout provides native diff buffers, an activity timeline, per-file checkpoints,
persistent comments and drafts, and explicit feedback delivery. Neovim can run
beside the repository or connect through an SSH port forward. No local checkout
is needed, and the review client makes no model calls.

The host uses ahpd’s SDK and Codex ACP adapter with a
[steering patch](docs/host-patch.md).

## Before trying it

- Start tasks through the included AHP host. Lookout cannot attach to an
  ordinary `codex` process already running in a terminal.
- Use a separate terminal AHP client to start tasks, select models, and handle
  approvals. Lookout adds a review interface to that setup; it does not provide
  the main agent conversation.
- `npm ci` applies a local patch to the pinned ahpd dependencies. The patch is
  not upstream yet, so changing those dependency versions requires checking it
  again.
- Tests run on Linux with Neovim 0.11.5 and Node.js 24. Laptop access through a
  real SSH port forward and the separate terminal client have not been tested
  together yet.

This is an early implementation for trying out the review workflow. Expect
bugs and changes to commands, configuration, and saved-state formats as it gets
used on real tasks.

## Requirements and installation

Neovim **0.11+** and Node.js **24+** are required on the Neovim machine. The
agent machine also needs Git, Node 24+, a Git repository, and Codex authenticated
with your ChatGPT subscription.

Build the bundled helper from this checkout:

```sh
cd /path/to/lookout.nvim
npm ci
npm run build
```

For example, configure lazy.nvim with:

```lua
{
  'rvforest/lookout.nvim',
  build = 'npm ci && npm run build',
  config = function()
    require('lookout').setup({
      hosts = {
        work = {
          url = 'ws://127.0.0.1:9187',
          token_file = '~/.config/lookout/work-token',
          -- Alternatively: token_env = 'LOOKOUT_TOKEN'
        },
      },
    })
  end,
}
```

Without a plugin manager, add this directory to `runtimepath`, source
`plugin/lookout.lua`, and call the same `setup`. Run
`:checkhealth lookout` to check the runtime. The bundled `dist/helper.mjs`
requires only Node at runtime, not a host installation on the Neovim machine.

## Start the host and an agent

Install this project on the repository’s machine too (`npm ci`). Confirm that
Codex is signed in as the same operating-system user that will run the host.
The adapter uses Codex authentication; this project does not read or copy its
credentials. The bundled compatible Codex CLI is available for login:

```sh
cd /path/to/lookout.nvim
./node_modules/.bin/codex login status
# If needed on a headless machine:
# ./node_modules/.bin/codex login --device-auth
npm run host -- --path /absolute/path/to/repository
```

Keep the host running in tmux or your process supervisor. It binds only to
loopback, requires a generated connection token, and prints the token file’s
path, not its contents. Default state is under `$XDG_STATE_HOME/lookout-host`
or `~/.local/state/lookout-host`. Override using `--state`, `--token-file`,
or `--port`.

Use an existing terminal AHP client for starting tasks, model selection, and
approvals. For example, [ahpc](https://github.com/softov/ahpc) provides an
interactive terminal interface (`@softov/ahpc@0.9.0` was inspected for this
setup). Follow its [connection guide](https://softov.github.io/ahpc/start/CONNECT)
to connect with the host token, create a Codex session, and start a task. That
independent client is not bundled or end-to-end tested here.

Set the Neovim profile’s local token file or environment variable to the host’s
connection token. Tokens are used in memory and are not saved in review caches.

### Neovim on your laptop

Keep an SSH port forward open:

```sh
ssh -N -L 9187:127.0.0.1:9187 your-server
```

Use `ws://127.0.0.1:9187` in the local profile and put the host’s token in the
configured local token file. Content is read through AHP; remote file paths
are never opened as local files.

If Neovim runs on the SSH machine, connect directly to loopback and point
`token_file` at the host’s token file. The review experience is identical.

## Review loop

1. `:Lookout connect work` — choose a session, feedback-recipient chat, and
   changeset. The recipient stays visible in the review.
2. Browse activity and press Enter on a file to inspect its native diff.
3. Press `s` to mark the displayed file seen. Later edits appear against that
   exact content. Press `a` to switch to the cumulative changeset view.
4. Let the agent work. **NEW CHANGES** signals newer state; `r` refreshes
   explicitly. The displayed content stays still while you read.
5. Press `c` for a file comment, or visually select diff lines and press `c` for
   a range comment. Comments retain their quoted context across refreshes.
6. Press `F` to collect feedback in a normal editable buffer. `:write` saves
   the local draft; `<LocalLeader>s` explicitly sends it. Edits also save after
   a short debounce. `<LocalLeader>q` saves and closes the composer.
7. Press `q` to close the review tab. Observation continues while Neovim is
   running. Agent execution belongs to the independently running host.

| Key / command | Action |
| --- | --- |
| Enter | Open a file or activity entry |
| `f` / `t` / `T` | Jump to files / activity / open recent activity |
| `]c` / `[c` | Native next / previous diff hunk |
| `r` | Refresh the frozen snapshot |
| `s` / `S` | Mark current / all displayed files seen |
| `a` | Toggle Since reviewed / All changes |
| `c` / `F` | Comment / compose feedback |
| `gS` / `gC` | Select session / changeset scope |
| `?` / `q` | Help / close review |
| `:Lookout open` | Reopen the current review |
| `:Lookout disconnect` | Disconnect the review client |
| `:Lookout clear` | Discard comments and draft after confirmation |

Feedback steers an active turn or starts a new turn when idle. If the turn
ends during delivery, the input stays with you; it is not silently queued.
**Accepted** means the host acknowledged delivery, not that the model acted on
it. Failed and uncertain submissions retain notes and text. Check the main
conversation before explicitly resending uncertain feedback.

## State and limitations

- One host, session, chat, and repository can be selected at a time. Switching
  between them keeps separate review checkpoints.
- Checkpoints, cached content, and unsent feedback are stored under
  `stdpath('state')/lookout`, separately for each host profile, session,
  chat, and changeset. They survive closing Neovim. They are local to each
  machine; laptop and server state are not synchronized. Use distinct profile
  names for distinct hosts.
- Scope labels come from the host. Branch and uncommitted views can include
  edits by you or other tools. Changes are shown by file and turn; Lookout
  does not group them into tasks. Static changesets are supported; arbitrary
  comparisons between past turns are not supported yet.
- Snapshot capture retries concurrent edits. Consistency across files is
  best effort, not a transactional filesystem snapshot.
- Text sides above 2 MiB are metadata-only and cannot be checkpointed. Binary
  content is metadata-only. Unavailable content remains visible and cannot
  be marked seen. Older comments retain their context in feedback rather
  than moving to potentially unrelated lines in a refreshed diff.
- Keep using the main terminal client for approvals, model selection, and
  task creation. This plugin does not stage, revert, commit, or merge code.

## Development

```sh
npm ci
npm test
NVIM_BIN=/path/to/nvim npm test  # include the headless UI integration test
npm run smoke:live              # opt-in real Codex task in a temporary repo
```

Tests use scripted agents and real AHP libraries without calling a model.
The optional live smoke check uses your Codex authentication
and subscription allowance; it removes its temporary repository afterward.
