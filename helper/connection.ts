import { EventEmitter } from 'node:events';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { SUPPORTED_PROTOCOL_VERSIONS, chatReducer, sessionReducer, changesetReducer } from '@microsoft/agent-host-protocol';
import type { ChatState, SessionState, ChangesetState, Snapshot, StateAction, ActionEnvelope } from '@microsoft/agent-host-protocol';

export class Connection extends EventEmitter {
  client?: AhpClient;
  states = new Map<string, unknown>();
  versions = new Map<string, number>();
  online = false;
  private subscriptions = new Set<string>();
  private sequences = new Map<string, number>();
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private delay = 500;
  constructor(private endpoint: string) { super(); }
  async start() {
    const generation = ++this.generation;
    this.stopped = false;
    try {
      const transport = await WebSocketTransport.connect(this.endpoint);
      if (generation !== this.generation || this.stopped) { await transport.close(); return; }
      const client = new AhpClient(transport, { requestTimeoutMs: 15000 });
      this.client = client;
      client.connect();
      const events = client.events();
      void (async () => {
        for await (const { event } of events) {
          if (generation !== this.generation) break;
          if (event.type === 'action') this.action(event.params);
        }
      })().catch((e) => this.emit('problem', e.message));
      await client.initialize({ clientId: `lookout-${crypto.randomUUID()}`, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
      for (const channel of this.subscriptions) await this.subscribe(channel);
      if (generation !== this.generation || this.stopped) return;
      this.online = true;
      this.delay = 500;
      this.emit('status', 'connected');
      void (async () => {
        for await (const state of client.stateChanges()) if (state.status === 'closed') {
          if (generation === this.generation && !this.stopped) this.retry();
          break;
        }
      })();
    } catch (error) {
      await this.client?.shutdown();
      this.emit('problem', 'Connection failed. Check the host, port forward, and token.');
      if (!this.stopped && generation === this.generation) this.retry();
      throw new Error('Could not connect to the agent host');
    }
  }
  private retry() {
    this.online = false;
    this.emit('status', 'disconnected — reconnecting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.start().catch(() => {}); }, this.delay);
    this.delay = Math.min(this.delay * 2, 15000);
  }
  private snapshot(snapshot: Snapshot) {
    this.sequences.set(snapshot.resource, snapshot.fromSeq);
    this.states.set(snapshot.resource, snapshot.state);
    this.versions.set(snapshot.resource, (this.versions.get(snapshot.resource) ?? 0) + 1);
    this.emit('update', snapshot.resource);
  }
  private action(envelope: ActionEnvelope) {
    this.emit('action', envelope);
    if (envelope.rejectionReason) return;
    const { channel, action } = envelope;
    if (envelope.serverSeq <= (this.sequences.get(channel) ?? -1)) return;
    this.sequences.set(channel, envelope.serverSeq);
    const state = this.states.get(channel);
    if (!state) return;
    if (action.type.startsWith('chat/')) this.states.set(channel, chatReducer(state as ChatState, action as Parameters<typeof chatReducer>[1]));
    else if (action.type.startsWith('changeset/')) this.states.set(channel, changesetReducer(state as ChangesetState, action as Parameters<typeof changesetReducer>[1]));
    else if (action.type.startsWith('session/')) this.states.set(channel, sessionReducer(state as SessionState, action as Parameters<typeof sessionReducer>[1]));
    this.versions.set(channel, (this.versions.get(channel) ?? 0) + 1);
    this.emit('update', channel);
  }
  async subscribe(channel: string, remember = true) {
    if (remember) this.subscriptions.add(channel);
    const { result } = await this.client!.subscribe(channel);
    if (result.snapshot) this.snapshot(result.snapshot);
    return this.states.get(channel);
  }
  async unsubscribe(channel: string) {
    this.subscriptions.delete(channel);
    if (this.online) await this.client?.unsubscribe(channel);
    this.states.delete(channel);
  }
  async stop() {
    this.stopped = true; ++this.generation; clearTimeout(this.timer);
    this.online = false;
    await this.client?.shutdown();
  }
  dispatch(channel: string, action: StateAction) {
    if (!this.online) throw new Error('Disconnected; feedback remains a draft');
    return this.client!.dispatch(channel, action);
  }
}
