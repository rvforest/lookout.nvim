import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Connection } from './connection.js';
import { Review, hash, same } from './review.js';
import type { Side, File } from './review.js';
import type { Changeset, ChangesetState, ChatState, SessionState, FileEditSide, ActionEnvelope } from '@microsoft/agent-host-protocol';

export type Target = { session: string; chat: string; changeset: string; label: string };
type Profile = { name: string; url: string; token?: string; stateDir: string };
const MAX_BYTES = 2 * 1024 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const title = (text: string) => text.replace(/\s+/g, ' ').slice(0, 140);

export class Controller {
  connection?: Connection;
  review?: Review;
  target?: Target;
  mode: 'since' | 'all' = 'since';
  status = 'disconnected';
  dirty = false;
  private profile?: Profile;
  private refreshing = false;
  private refreshVersion = -1;
  private pending?: { id: string; clientSeq: number; channel: string; timer: NodeJS.Timeout };
  private activityTimer?: NodeJS.Timeout;
  private watches: string[] = [];
  constructor(private emit: (event: string, data: unknown) => void) {}
  private state<T>(uri: string) { return this.connection?.states.get(uri) as T | undefined; }
  private identity(target: Target) { return JSON.stringify([this.profile!.name, target.session, target.chat, target.changeset]); }
  private lastPath() { return join(this.profile!.stateDir, `last-${hash(this.profile!.name)}.json`); }
  private activity() {
    const chat = this.target && this.state<ChatState>(this.target.chat);
    const session = this.target && this.state<SessionState>(this.target.session);
    return { status: this.status, dirty: this.dirty, host: this.profile?.name,
      target: this.target, activity: chat?.activity ?? (chat?.activeTurn ? 'Working' : 'Idle'),
      repository: (chat?.workingDirectories ?? session?.workingDirectories)?.join(', '),
      timeline: [...(chat?.turns ?? []), ...(chat?.activeTurn ? [chat.activeTurn] : [])].slice(-30).reverse().map((turn) => ({
        id: turn.id, time: turn.startedAt, text: title(turn.message.text ?? ''),
        response: title(turn.responseParts.filter((p) => p.kind === 'markdown').map((p) => 'content' in p ? p.content : '').join(' ')),
        active: turn === chat?.activeTurn,
      })),
      delivery: this.review?.data.delivery, notes: this.review?.data.notes.length ?? 0,
    };
  }
  private emitActivity() {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => { this.activityTimer = undefined; this.emit('activity', this.activity()); }, 100);
  }
  publish() {
    this.emit('view', { ...this.activity(), mode: this.mode, snapshot: this.review?.data.snapshot,
      files: this.review?.visible(this.mode) ?? [], notes: this.review?.data.notes ?? [],
      draft: this.review?.data.draft ?? '' });
  }
  async connect(profile: Profile) {
    await this.disconnect();
    this.target = undefined; this.review = undefined; this.watches = [];
    this.mode = 'since'; this.dirty = false;
    const endpoint = new URL(profile.url);
    if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('Host URL must use ws:// or wss://');
    this.profile = profile;
    this.publish();
    // Tokens are passed only in memory. Neither URL nor token is persisted.
    if (profile.token) endpoint.searchParams.set('tkn', profile.token);
    try {
      const last: Target = JSON.parse(await readFile(this.lastPath(), 'utf8'));
      if (typeof last.session === 'string' && typeof last.chat === 'string' && typeof last.changeset === 'string') {
        this.target = last;
        this.review = await Review.load(profile.stateDir, this.identity(last));
        this.dirty = true;
        this.publish();
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('problem', 'Could not restore the previous review; select a session to continue.'); }
    const connection = new Connection(endpoint.href);
    this.connection = connection;
    connection.on('problem', (text) => this.emit('problem', text));
    connection.on('status', (status: string) => {
      this.status = status;
      if (!connection.online) { this.dirty = true; void this.uncertain('Connection lost; check the chat before resending.'); }
      else if (this.target) void this.watchTarget().catch(() => {});
      this.emitActivity();
    });
    connection.on('action', (action: ActionEnvelope) => {
      if (action.action.type === 'resourceWatch/changed') { this.dirty = true; this.emitActivity(); }
      void this.ack(action).catch((e) => this.emit('problem', e.message));
    });
    connection.on('update', (channel: string) => {
      if (channel === this.target?.changeset && (connection.versions.get(channel) ?? 0) !== this.refreshVersion) this.dirty = true;
      this.emitActivity();
    });
    try {
      await connection.start();
      if (this.target) {
        try { await this.subscribeTarget(this.target); await this.watchTarget(); this.emitActivity(); }
        catch { this.emit('problem', 'Previous session is unavailable. Cached review is still readable; select another session to continue.'); }
      }
    } catch { this.publish(); throw new Error('Could not connect. Cached review remains available; reconnecting in the background.'); }
    return { restored: Boolean(this.target) };
  }
  async disconnect() {
    await this.uncertain('Disconnected before acknowledgement; check the chat before resending.');
    await this.connection?.stop();
    clearTimeout(this.activityTimer); this.activityTimer = undefined;
    this.status = 'disconnected'; this.emitActivity();
  }
  private online() {
    if (!this.connection?.online) throw new Error('Host is disconnected; the cached review is still readable');
    return this.connection;
  }
  async sessions() {
    const connection = this.online();
    const items = [];
    let cursor: string | undefined;
    do {
      const result = await connection.client!.request('listSessions', { channel: 'ahp-root://', limit: 100, cursor });
      items.push(...result.items); cursor = result.nextCursor;
    } while (cursor);
    return items;
  }
  async chats(session: string) {
    const state = await this.online().subscribe(session) as SessionState;
    return state.chats.filter((chat) => chat.interactivity !== 'hidden');
  }
  async changesets(session: string, chat: string) {
    const connection = this.online();
    const state = await connection.subscribe(chat) as ChatState;
    const catalogue = [...(state.changesets ?? []), ...(this.state<SessionState>(session)?.changesets ?? [])];
    const seen = new Set<string>();
    return catalogue.filter((entry) => !entry.uriTemplate.includes('{') && !seen.has(entry.uriTemplate) && Boolean(seen.add(entry.uriTemplate)));
  }
  private async subscribeTarget(target: Target) {
    const connection = this.online();
    await connection.subscribe(target.session);
    await connection.subscribe(target.chat);
    await connection.subscribe(target.changeset);
  }
  private async watchTarget() {
    const connection = this.online();
    for (const channel of this.watches) await connection.unsubscribe(channel).catch(() => {});
    this.watches = [];
    if (!this.target) return;
    const chat = this.state<ChatState>(this.target.chat);
    const session = this.state<SessionState>(this.target.session);
    const directory = (chat?.workingDirectories ?? session?.workingDirectories)?.[0];
    if (!directory) return;
    try {
      const result = await connection.client!.request('createResourceWatch', { channel: 'ahp-root://', uri: directory,
        recursive: true, excludes: { items: ['**/.git/**', '**/node_modules/**', '**/.cache/**'] } });
      await connection.subscribe(result.channel, false);
      this.watches = [result.channel];
    } catch { this.emit('problem', 'Filesystem watch unavailable. Agent events still update activity; use refresh to check for other edits.'); }
  }
  async select(target: Target) {
    if (this.pending) throw new Error('Wait for feedback delivery before switching reviews');
    await this.subscribeTarget(target);
    if (this.target) {
      const next = new Set([target.session, target.chat, target.changeset]);
      for (const old of new Set([this.target.session, this.target.chat, this.target.changeset])) {
        if (!next.has(old)) await this.connection!.unsubscribe(old).catch(() => {});
      }
    }
    this.target = target;
    this.review = await Review.load(this.profile!.stateDir, this.identity(target));
    await mkdir(this.profile!.stateDir, { recursive: true, mode: 0o700 });
    const path = this.lastPath();
    await writeFile(`${path}.tmp`, JSON.stringify(target), { mode: 0o600 }); await rename(`${path}.tmp`, path);
    this.mode = 'since'; this.dirty = true; this.publish();
    await this.watchTarget();
    await this.refresh();
  }
  private async side(side?: FileEditSide, missingAllowed = false): Promise<Side | null> {
    if (!side) return null;
    const ref = side.content;
    if ((ref.sizeHint ?? 0) > MAX_BYTES) return { uri: side.uri, kind: 'large', hash: `${ref.nonce ?? ''}:${ref.sizeHint}` };
    try {
      const result = await this.online().client!.request('resourceRead', { channel: 'ahp-root://', uri: ref.uri });
      const bytes = Buffer.from(result.data, result.encoding === 'base64' ? 'base64' : 'utf8');
      const digest = hash(bytes.toString('base64'));
      if (bytes.length > MAX_BYTES) return { uri: side.uri, kind: 'large', hash: digest };
      const mime = result.contentType ?? ref.contentType ?? '';
      if (bytes.includes(0) || /^(image|audio|video)\//.test(mime) || mime === 'application/octet-stream') return { uri: side.uri, kind: 'binary', hash: digest };
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return { uri: side.uri, kind: 'binary', hash: digest }; }
      return { uri: side.uri, kind: 'text', text, hash: digest };
    } catch (error) {
      if (missingAllowed && (error as { code?: number }).code === -32008) return null;
      return { uri: side.uri, kind: 'unavailable', hash: '', error: 'Content unavailable; retry refresh' };
    }
  }
  async refresh() {
    if (!this.target || !this.review) throw new Error('Select a review first');
    if (this.refreshing) throw new Error('A refresh is already running');
    const connection = this.online();
    this.refreshing = true;
    const target = this.target, review = this.review;
    try {
      // A fresh subscription snapshot asks the host to recompute SCM state,
      // including edits made by shells or other clients between agent events.
      await connection.subscribe(target.changeset);
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = this.state<ChangesetState>(target.changeset);
        if (!state || state.status !== 'ready') { await sleep(200); continue; }
        const version = connection.versions.get(target.changeset);
        const files: File[] = [];
        // Small worker batches bound RPC concurrency and let Neovim stay responsive.
        for (let index = 0; index < state.files.length; index += 4) {
          files.push(...await Promise.all(state.files.slice(index, index + 4).map(async (entry) => ({
            id: entry.id, path: decodeURIComponent((entry.edit.after?.uri ?? entry.edit.before?.uri ?? entry.id).replace(/^file:\/\//, '')),
            before: await this.side(entry.edit.before), after: await this.side(entry.edit.after),
          }))));
        }
        // Keep checkpointed paths even if the host no longer includes the file.
        for (const old of review.data.files) if (!files.some((file) => file.id === old.id)) {
          const uri = old.after?.uri ?? old.before?.uri;
          const after = uri ? await this.side({ uri, content: { uri } }, true) : null;
          files.push({ ...old, after, removedFromChangeset: true });
        }
        // Re-read each side to detect mutable content references changing during capture.
        let stable = true;
        for (let index = 0; index < files.length; index += 4) {
          const results = await Promise.all(files.slice(index, index + 4).map(async (file) => {
            const original = state.files.find((entry) => entry.id === file.id);
            if (!original) {
              const uri = file.after?.uri ?? file.before?.uri;
              return same(file.after, uri ? await this.side({ uri, content: { uri } }, true) : null);
            }
            return same(file.before, await this.side(original.edit.before)) && same(file.after, await this.side(original.edit.after));
          }));
          stable &&= results.every(Boolean);
        }
        if (target !== this.target || review !== this.review) throw new Error('Review changed during refresh');
        if (!stable || version !== connection.versions.get(target.changeset)) { await sleep(150); continue; }
        this.refreshVersion = version ?? -1;
        await review.replace(files, target.label);
        this.dirty = this.refreshVersion !== connection.versions.get(target.changeset);
        this.publish(); return;
      }
      throw new Error('Changes are still being computed or edited. Kept your previous snapshot; retry refresh shortly.');
    } finally { this.refreshing = false; }
  }
  async seen(id?: string) {
    const review = this.requireReview();
    await review.seen(id ?? review.visible(this.mode).map((file) => file.id));
    this.publish();
  }
  view(mode: 'since' | 'all') { this.mode = mode; this.publish(); }
  private requireReview() { if (!this.review) throw new Error('Select a review first'); return this.review; }
  async comment(input: Parameters<Review['comment']>[0] & { snapshot?: string }) {
    const review = this.requireReview();
    if (input.snapshot && input.snapshot !== review.data.snapshot) throw new Error('Snapshot changed while composing the comment; select the context again');
    await review.comment(input, this.mode); this.publish();
  }
  async draft(text: string) { const review = this.requireReview(); review.data.draft = text; await review.save(); }
  feedback() { return this.requireReview().feedback(); }
  async clearNotes() { const review = this.requireReview(); review.data.notes = []; review.data.draft = ''; await review.save(); this.publish(); }
  async send(text: string) {
    const connection = this.online(), review = this.requireReview();
    if (!text.trim()) throw new Error('Feedback is empty');
    if (this.pending) throw new Error('Feedback delivery is already pending');
    const chat = this.state<ChatState>(this.target!.chat);
    if (!chat || chat.interactivity === 'read-only' || chat.interactivity === 'hidden') throw new Error('Selected chat does not accept feedback');
    const id = crypto.randomUUID();
    review.data.draft = text;
    review.data.delivery = { id, text, state: 'pending' };
    await review.save();
    const action = chat.activeTurn
      ? { type: 'chat/pendingMessageSet' as const, kind: 'steering' as const, id, message: { text } }
      : { type: 'chat/turnStarted' as const, turnId: id, startedAt: new Date().toISOString(), message: { text } };
    // The event loop cannot receive an acknowledgement between dispatch and
    // recording this handle; no automatic retry ever sends it twice.
    let dispatched: ReturnType<Connection['dispatch']>;
    try { dispatched = connection.dispatch(this.target!.chat, action as Parameters<Connection['dispatch']>[1]); }
    catch (error) {
      review.data.delivery.state = 'failed';
      review.data.delivery.reason = 'Feedback could not be submitted; your draft is saved.';
      await review.save(); this.publish(); throw error;
    }
    this.pending = { id, clientSeq: dispatched.clientSeq, channel: this.target!.chat,
      timer: setTimeout(() => { void this.uncertain('No host acknowledgement; check the chat before resending.'); }, 20000) };
    this.publish();
  }
  private async ack(envelope: ActionEnvelope) {
    const pending = this.pending;
    if (!pending || envelope.channel !== pending.channel) return;
    const action = envelope.action;
    const match = ('id' in action && action.id === pending.id) || ('turnId' in action && action.turnId === pending.id);
    if (!match) return;
    clearTimeout(pending.timer); this.pending = undefined;
    const review = this.requireReview();
    const rejected = envelope.rejectionReason;
    review.data.delivery = { id: pending.id, text: review.data.delivery!.text, state: rejected ? (/uncertain/i.test(rejected) ? 'uncertain' : 'failed') : 'accepted', reason: rejected };
    if (!rejected) { review.data.notes = []; review.data.draft = ''; }
    await review.save(); this.publish();
  }
  private async uncertain(reason: string) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); this.pending = undefined;
    if (this.review?.data.delivery) {
      this.review.data.delivery.state = 'uncertain'; this.review.data.delivery.reason = reason;
      await this.review.save(); this.publish();
    }
  }
}
