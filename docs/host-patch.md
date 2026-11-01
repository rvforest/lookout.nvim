# Local ahpd steering bridge

`scripts/patch-host.mjs` patches the pinned ahpd packages. `npm ci` applies
it through postinstall; the host launcher checks it again. It validates exact
package versions and all replacement contexts before changing installed files,
and is idempotent. Do not update the pinned packages without reviewing it.

## Original gap

The published `@ahpd/agent-acp@0.14.0` backend has no `Session.steer` method.
The Codex adapter supports `_session/steering`, but the host does not forward
it. Without the patch, steering is rejected with:
`This backend cannot take a message mid-turn`.

## Implementation

1. Add an ACP connection request for `_session/steering` with text content and
   `_meta.steering.idleBehavior: 'promptRequired'`. A late steer must remain
   unconsumed rather than starting an adapter-owned turn.
2. Add an asynchronous ACP session steering method. Check the initialize
   reply’s `_meta.steering.supported`, confirm the same turn remains active,
   and accept only `injected`. Only text feedback is supported.
3. Await boolean-or-reason delivery in ahpd’s chat action handler. Reject
   failures through the originating client’s AHP action envelope. Emit
   pending-message set/remove actions after confirmed adapter injection.

There are no AHP wire changes, cancellations, or implicit queues. Existing
synchronous backends still work through `Promise.resolve`. Host automations
are outside this integration; the included launcher does not enable them.

The patch targets distribution JavaScript so the integration is reproducible
with locked npm packages. An upstream contribution would apply this behavior
to the original TypeScript and describe the async result in the session and
connection types. No upstream PR has been opened.

`tests/steering.test.mjs` runs the actual patched backend against a controlled
stdio ACP subprocess. It tests multi-client observation, injected feedback,
unsupported capability, a turn-ending race, and adapter errors. The fake
adapter rejects requests missing the host-owned idle behavior, making that
race policy part of the integration test.
