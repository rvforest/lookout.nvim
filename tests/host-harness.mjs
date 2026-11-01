import { createHost, createPeer, receive } from '@ahpd/sdk';
import { AhpClient, InMemoryTransport } from '@microsoft/agent-host-protocol/client';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
export async function attach(host, clientId = crypto.randomUUID()) {
  const [transport, server] = InMemoryTransport.pair();
  const peer = createPeer({ send: (text) => server.send(text), close: () => server.close(), isOpen: () => true });
  const connection = host.accept(peer);
  const pump = (async () => { for (;;) {
    const frame = await server.recv(); if (!frame) break;
    receive(frame.text, peer, (request) => connection.handle(request));
  } })();
  const client = new AhpClient(transport, { requestTimeoutMs: 10000 });
  client.connect();
  await client.initialize({ clientId, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
  return { client, close: async () => { await client.shutdown(); connection.close(); await server.close(); await pump; } };
}
export async function harness(options) {
  const host = createHost(options);
  const connection = await attach(host);
  return { ...connection, host, close: async () => { await connection.close(); await host.close(); } };
}
export function waitAction(client, predicate) {
  const stream = client.events();
  let timeout;
  const result = (async () => {
    for await (const { event } of stream) if (event.type === 'action' && predicate(event.params)) return event.params;
    throw new Error('Stream ended');
  })();
  return Promise.race([result, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Action timeout')), 10000); })])
    .finally(() => { clearTimeout(timeout); void stream.return(); });
}
