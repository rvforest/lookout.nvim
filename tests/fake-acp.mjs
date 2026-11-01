// Deterministic ACP subprocess; inference-free integration tests only.
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let pending;
const mode = process.argv[2] ?? 'injected';
if (process.env.LOOKOUT_DEBUG) console.error('fake ACP starting', mode);
const update = (text) => send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.LOOKOUT_DEBUG) console.error('fake ACP method', request.method);
  const answer = (result) => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize': answer({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], _meta: { steering: { supported: mode !== 'unsupported' } } }); break;
    case 'session/new': answer({ sessionId: 'fake-session' }); break;
    case 'session/list': answer({ sessions: [] }); break;
    case 'session/prompt': pending = request.id; update('Waiting for feedback'); break;
    case '_session/steering':
      if (request.params._meta?.steering?.idleBehavior !== 'promptRequired') {
        send({ id: request.id, error: { code: -32602, message: 'Missing host-owned idle behavior' } }); break;
      }
      if (mode === 'hold') break;
      if (mode === 'error') { send({ id: request.id, error: { code: -32000, message: 'Simulated delivery failure' } }); break; }
      answer({ outcome: mode, ...(mode === 'promptRequired' ? { reason: 'noRunningTurn' } : {}) });
      if (mode === 'injected') {
        update(`\nReceived: ${request.params.prompt[0].text}`);
        send({ id: pending, result: { stopReason: 'end_turn' } });
      }
      break;
    case 'session/cancel': if (pending) send({ id: pending, result: { stopReason: 'cancelled' } }); break;
    default: if (request.id !== undefined) send({ id: request.id, error: { code: -32601, message: 'Unknown test method' } });
  }
}
