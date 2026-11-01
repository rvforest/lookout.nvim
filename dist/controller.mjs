// helper/controller.ts
import { readFile as readFile2, mkdir as mkdir2, writeFile as writeFile2, rename as rename2 } from "node:fs/promises";
import { join as join2 } from "node:path";

// helper/connection.ts
import { EventEmitter } from "node:events";

// node_modules/@microsoft/agent-host-protocol/dist/types/common/errors.js
var JsonRpcErrorCodes = {
  /** Invalid JSON */
  ParseError: -32700,
  /** Not a valid JSON-RPC request */
  InvalidRequest: -32600,
  /** Unknown method name */
  MethodNotFound: -32601,
  /** Invalid method parameters */
  InvalidParams: -32602,
  /** Unspecified server error */
  InternalError: -32603
};

// node_modules/@microsoft/agent-host-protocol/dist/client/async-queue.js
var AsyncBroadcastQueue = class {
  buffer = [];
  /** Absolute logical position of `buffer[0]` (entries below have been dropped). */
  base = 0;
  cursors = /* @__PURE__ */ new Set();
  closed = false;
  bufferLimit;
  constructor(bufferLimit = 4096) {
    this.bufferLimit = bufferLimit;
  }
  /** Whether the queue has been closed. New readers see immediate end-of-stream. */
  get isClosed() {
    return this.closed;
  }
  /** Whether at least one reader is attached. */
  get hasReaders() {
    return this.cursors.size > 0;
  }
  /** Publish a value to every attached reader. */
  publish(value) {
    if (this.closed)
      return;
    this.buffer.push(value);
    if (this.buffer.length > this.bufferLimit) {
      const drop = this.buffer.length - this.bufferLimit;
      this.buffer.splice(0, drop);
      this.base += drop;
      for (const cursor of this.cursors) {
        if (cursor.position < this.base)
          cursor.position = this.base;
      }
    }
    const lastPos = this.base + this.buffer.length - 1;
    for (const cursor of this.cursors) {
      if (cursor.waiter && cursor.position <= lastPos) {
        const idx = cursor.position - this.base;
        const item = this.buffer[idx];
        cursor.position += 1;
        const w = cursor.waiter;
        cursor.waiter = null;
        w.resolve({ value: item, done: false });
      }
    }
    this.trim();
  }
  /**
   * Close the queue. New readers see immediate end-of-stream. Existing
   * readers can still drain values that were published before close;
   * once their cursor reaches the end of the buffer they see end-of-stream.
   */
  close() {
    if (this.closed)
      return;
    this.closed = true;
    for (const cursor of this.cursors) {
      if (cursor.waiter && cursor.position - this.base >= this.buffer.length) {
        const w = cursor.waiter;
        cursor.waiter = null;
        w.resolve({ value: void 0, done: true });
      }
    }
  }
  /** Create a new independent reader. */
  reader() {
    const cursor = {
      position: this.base + this.buffer.length,
      waiter: null,
      detached: this.closed
    };
    if (!this.closed)
      this.cursors.add(cursor);
    const queue = this;
    const detach = () => {
      if (!cursor.detached) {
        cursor.detached = true;
        queue.cursors.delete(cursor);
        queue.trim();
      }
    };
    const iter = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (cursor.detached) {
          return Promise.resolve({ value: void 0, done: true });
        }
        const idx = cursor.position - queue.base;
        if (idx >= 0 && idx < queue.buffer.length) {
          const item = queue.buffer[idx];
          cursor.position += 1;
          queue.trim();
          return Promise.resolve({ value: item, done: false });
        }
        if (queue.closed) {
          return Promise.resolve({ value: void 0, done: true });
        }
        return new Promise((resolve) => {
          cursor.waiter = { resolve };
        });
      },
      return() {
        detach();
        return Promise.resolve({ value: void 0, done: true });
      }
    };
    return iter;
  }
  [Symbol.asyncIterator]() {
    return this.reader();
  }
  /** Drop buffer entries that every cursor has already consumed. */
  trim() {
    if (this.cursors.size === 0) {
      const dropped = this.buffer.length;
      if (dropped > 0) {
        this.buffer = [];
        this.base += dropped;
      }
      return;
    }
    let minPos = Infinity;
    for (const cursor of this.cursors) {
      if (cursor.position < minPos)
        minPos = cursor.position;
    }
    const drop = minPos - this.base;
    if (drop > 0) {
      this.buffer.splice(0, drop);
      this.base += drop;
    }
  }
};

// node_modules/@microsoft/agent-host-protocol/dist/client/error.js
var AhpClientError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AhpClientError";
  }
};
var RpcError = class extends AhpClientError {
  /** JSON-RPC numeric error code. See `JsonRpcErrorCodes` and `AhpErrorCodes`. */
  code;
  /** Optional structured payload included in the response. */
  data;
  constructor(code, message, data) {
    super(`RPC error ${code}: ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
};
var RpcTimeoutError = class extends AhpClientError {
  /** The JSON-RPC method name that timed out. */
  method;
  /** The configured timeout in milliseconds that was exceeded. */
  timeoutMs;
  constructor(method, timeoutMs) {
    super(`Request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
};
var TransportError = class extends AhpClientError {
  /** What kind of transport failure this represents. */
  kind;
  constructor(kind, message, options) {
    super(message, options);
    this.name = "TransportError";
    this.kind = kind;
  }
};
var ClientClosedError = class extends AhpClientError {
  constructor(message = "client shut down") {
    super(message);
    this.name = "ClientClosedError";
  }
};

// node_modules/@microsoft/agent-host-protocol/dist/client/transport.js
function encodeMessage(message) {
  return JSON.stringify(message);
}
function decodeMessage(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new TransportError("protocol", `invalid JSON: ${cause.message}`, { cause });
  }
}

// node_modules/@microsoft/agent-host-protocol/dist/client/client.js
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var DEFAULT_SUBSCRIPTION_BUFFER = 4096;
function noop() {
}
var Subscription = class {
  /** Channel URI this subscription is bound to. */
  uri;
  /** @internal */
  inner;
  /** @internal */
  constructor(uri, inner) {
    this.uri = uri;
    this.inner = inner;
  }
  next() {
    return this.inner.next();
  }
  return() {
    return this.inner.return ? this.inner.return() : Promise.resolve({ value: void 0, done: true });
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  /** Terminate this consumer's iterator. Does not unsubscribe server-side. */
  async close() {
    await this.return();
  }
};
function createResourceRequestHandler(handlers) {
  return (async (method, params) => {
    const handler = handlers[method];
    if (!handler) {
      throw new RpcError(JsonRpcErrorCodes.MethodNotFound, `no handler for server method "${method}"`);
    }
    return handler(params);
  });
}
var AhpClient = class {
  transport;
  requestTimeoutMs;
  subscriptionBuffer;
  pending = /* @__PURE__ */ new Map();
  subscriptions = /* @__PURE__ */ new Map();
  allEvents = new AsyncBroadcastQueue();
  stateQueue = new AsyncBroadcastQueue();
  nextRequestId = 1;
  nextClientSeq = 1;
  state = { status: "idle" };
  receiveLoop = null;
  serverRequestHandler = null;
  constructor(transport, config = {}) {
    this.transport = transport;
    const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requestTimeoutMs = timeout > 0 ? timeout : 0;
    const buffer = config.subscriptionBuffer ?? DEFAULT_SUBSCRIPTION_BUFFER;
    this.subscriptionBuffer = buffer >= 1 ? Math.floor(buffer) : 1;
  }
  /** Current connection state. */
  get connectionState() {
    return this.state;
  }
  /** AsyncIterable stream of connection-state transitions. */
  stateChanges() {
    return this.stateQueue.reader();
  }
  /**
   * Top-level fan-in stream of every inbound event from this client.
   *
   * Each call returns a fresh independent iterator. Events are also
   * delivered to the matching per-URI {@link Subscription}.
   */
  events() {
    return this.allEvents.reader();
  }
  /**
   * Install a handler for server-initiated requests
   * ({@link ServerCommandMap}). If no handler is installed, the client
   * responds with a JSON-RPC `MethodNotFound` error so the server does
   * not leak pending requests.
   */
  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }
  /**
   * Install typed per-method handlers for inbound server-initiated resource
   * requests ({@link ServerCommandMap}). Sugar over
   * {@link AhpClient.setServerRequestHandler} +
   * {@link createResourceRequestHandler}: a method left undefined is reported
   * to the peer as JSON-RPC `MethodNotFound`. Pass `null` to clear the
   * installed handler.
   */
  setResourceRequestHandlers(handlers) {
    this.setServerRequestHandler(handlers ? createResourceRequestHandler(handlers) : null);
  }
  /**
   * Start the inbound receive loop. Idempotent — calling more than once
   * is a no-op.
   */
  connect() {
    if (this.receiveLoop)
      return;
    this.setState({ status: "connected" });
    this.receiveLoop = this.driveTransport();
  }
  /**
   * Gracefully shut down the client. Closes the transport, rejects every
   * pending request with {@link ClientClosedError}, and terminates all
   * subscription and event streams.
   */
  async shutdown() {
    if (this.state.status === "closing" || this.state.status === "closed")
      return;
    this.setState({ status: "closing" });
    this.tearDown({ type: "shutdown" });
    try {
      await this.transport.close();
    } catch {
    }
    if (this.receiveLoop) {
      try {
        await this.receiveLoop;
      } catch {
      }
    }
  }
  // ─── Typed protocol helpers ────────────────────────────────────────────────
  /**
   * Send the `initialize` handshake. MUST be the first request after
   * {@link AhpClient.connect}.
   */
  async initialize(args) {
    const params = {
      channel: "ahp-root://",
      clientId: args.clientId,
      protocolVersions: [...args.protocolVersions],
      ...args.initialSubscriptions && args.initialSubscriptions.length > 0 ? { initialSubscriptions: [...args.initialSubscriptions] } : {},
      ...args.locale !== void 0 ? { locale: args.locale } : {}
    };
    return this.request("initialize", params);
  }
  /** Re-establish a dropped connection. */
  async reconnect(args) {
    const params = {
      channel: "ahp-root://",
      clientId: args.clientId,
      lastSeenServerSeq: args.lastSeenServerSeq,
      subscriptions: [...args.subscriptions]
    };
    return this.request("reconnect", params);
  }
  /**
   * Subscribe to a URI and obtain a {@link Subscription} that streams
   * subsequent events. The returned subscription is registered locally
   * before the `subscribe` request is sent, so no events delivered during
   * the round-trip are missed.
   */
  async subscribe(uri, options = {}) {
    const subscription = this.attachSubscription(uri);
    try {
      const params = {
        channel: uri,
        ...options.delivery ? { delivery: options.delivery } : {},
        ...options.view ? { view: options.view } : {}
      };
      const result = await this.request("subscribe", params);
      return { result, subscription };
    } catch (err) {
      await subscription.close();
      throw err;
    }
  }
  /**
   * Attach a new local {@link Subscription} without sending a `subscribe`
   * request — use this when the URI was included in `initialSubscriptions`
   * during {@link AhpClient.initialize}, or to add an additional consumer
   * for a URI that is already subscribed.
   *
   * Throws {@link ClientClosedError} after the client has been shut down.
   */
  attachSubscription(uri) {
    this.assertOpen();
    let queue = this.subscriptions.get(uri);
    if (!queue) {
      queue = new AsyncBroadcastQueue(this.subscriptionBuffer);
      this.subscriptions.set(uri, queue);
    }
    return new Subscription(uri, queue.reader());
  }
  /**
   * Send an `unsubscribe` notification and drop the local fan-out for
   * this URI. Any active {@link Subscription} iterators terminate.
   *
   * No-op after the client has been shut down.
   */
  async unsubscribe(uri) {
    if (this.isClosed())
      return;
    const queue = this.subscriptions.get(uri);
    if (queue) {
      this.subscriptions.delete(uri);
      queue.close();
    }
    const params = { channel: uri };
    this.notify("unsubscribe", params);
    return Promise.resolve();
  }
  /**
   * Fire a write-ahead `dispatchAction` notification.
   *
   * If `clientSeq` is omitted, the client uses its internal monotonic
   * counter. If supplied, the counter advances to `max(current,
   * clientSeq + 1)` so subsequent auto-assigned sequences remain
   * monotonic.
   *
   * Throws {@link ClientClosedError} after the client has been shut down.
   */
  dispatch(channel, action, clientSeq) {
    this.assertOpen();
    const seq = clientSeq ?? this.nextClientSeq;
    if (clientSeq !== void 0) {
      if (seq + 1 > this.nextClientSeq)
        this.nextClientSeq = seq + 1;
    } else {
      this.nextClientSeq = seq + 1;
    }
    const params = { channel, clientSeq: seq, action };
    this.notify("dispatchAction", params);
    return { clientSeq: seq };
  }
  /**
   * Protocol-level liveness ping. Useful in browsers, which cannot send
   * WebSocket ping frames directly.
   *
   * `ping` is a connection-level command; its channel is always
   * `ahp-root://`.
   */
  async ping() {
    const params = { channel: "ahp-root://" };
    await this.request("ping", params);
  }
  // ─── Resource commands ─────────────────────────────────────────────────────
  //
  // Typed convenience wrappers over the symmetrical `resource*` family. Each
  // targets the root channel (`ahp-root://`), so callers omit `channel`. The
  // reverse direction — a server calling these on the client — is handled via
  // {@link AhpClient.setResourceRequestHandlers}.
  /** Read the content of a resource by URI (`resourceRead`). */
  async resourceRead(params) {
    return this.request("resourceRead", { ...params, channel: "ahp-root://" });
  }
  /** Write content to a file on the receiver's filesystem (`resourceWrite`). */
  async resourceWrite(params) {
    return this.request("resourceWrite", { ...params, channel: "ahp-root://" });
  }
  /** List directory entries at a file URI (`resourceList`). */
  async resourceList(params) {
    return this.request("resourceList", { ...params, channel: "ahp-root://" });
  }
  /** Copy a resource from one URI to another (`resourceCopy`). */
  async resourceCopy(params) {
    return this.request("resourceCopy", { ...params, channel: "ahp-root://" });
  }
  /** Delete a resource at a URI (`resourceDelete`). */
  async resourceDelete(params) {
    return this.request("resourceDelete", { ...params, channel: "ahp-root://" });
  }
  /** Move (rename) a resource from one URI to another (`resourceMove`). */
  async resourceMove(params) {
    return this.request("resourceMove", { ...params, channel: "ahp-root://" });
  }
  /** Resolve a resource — `stat` + `realpath` (`resourceResolve`). */
  async resourceResolve(params) {
    return this.request("resourceResolve", { ...params, channel: "ahp-root://" });
  }
  /** Create a directory with `mkdir -p` semantics (`resourceMkdir`). */
  async resourceMkdir(params) {
    return this.request("resourceMkdir", { ...params, channel: "ahp-root://" });
  }
  /** Request permission to access a resource (`resourceRequest`). */
  async resourceRequest(params) {
    return this.request("resourceRequest", { ...params, channel: "ahp-root://" });
  }
  /**
   * Create a resource watcher (`createResourceWatch`). Returns the
   * `ahp-resource-watch:/<id>` channel URI; {@link AhpClient.subscribe} to it
   * to receive change events, and {@link AhpClient.unsubscribe} to release the
   * watcher.
   */
  async createResourceWatch(params) {
    return this.request("createResourceWatch", {
      ...params,
      channel: "ahp-root://"
    });
  }
  // ─── Completions commands ──────────────────────────────────────────────────
  /**
   * Request inline completion items for a partially-typed input
   * (`completions`), e.g. to power `@`-mention pickers. Unlike the `resource*`
   * wrappers, the caller-supplied `channel` (the chat URI the completion is
   * scoped to) is preserved. Debounce calls to avoid flooding the server on
   * every keystroke.
   */
  async completions(params) {
    return this.request("completions", params);
  }
  /**
   * Query the server for allowed values of a dynamic session config property
   * (`sessionConfigCompletions`). Targets the root channel, so callers omit
   * `channel`.
   */
  async sessionConfigCompletions(params) {
    return this.request("sessionConfigCompletions", {
      ...params,
      channel: "ahp-root://"
    });
  }
  // ─── Lower-level JSON-RPC ──────────────────────────────────────────────────
  /** Send a JSON-RPC request and await its result. */
  async request(method, params) {
    this.assertOpen();
    const id = this.nextRequestId++;
    const msg = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: (value) => resolve(value),
        reject,
        method,
        timer: null
      };
      this.pending.set(id, pending);
      if (this.requestTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new RpcTimeoutError(method, this.requestTimeoutMs));
          }
        }, this.requestTimeoutMs);
      }
      this.sendMessage(msg).catch((err) => {
        if (this.pending.delete(id)) {
          if (pending.timer)
            clearTimeout(pending.timer);
          reject(err);
        }
      });
    });
  }
  /**
   * Send a JSON-RPC notification (fire-and-forget).
   *
   * Throws {@link ClientClosedError} after the client has been shut down.
   * Transport-level send failures surface synchronously via
   * {@link AhpClient.connectionState} (the receive loop also tears down
   * on the next inbound failure).
   */
  notify(method, params) {
    this.assertOpen();
    const msg = {
      jsonrpc: "2.0",
      method,
      params
    };
    this.sendMessage(msg).catch(noop);
  }
  // ─── Internals ─────────────────────────────────────────────────────────────
  isClosed() {
    return this.state.status === "closing" || this.state.status === "closed";
  }
  assertOpen() {
    if (this.isClosed())
      throw new ClientClosedError();
  }
  async sendMessage(msg) {
    try {
      await this.transport.send(msg);
    } catch (err) {
      const te = err instanceof TransportError ? err : new TransportError("io", `transport send failed: ${err.message}`, { cause: err });
      this.tearDown({ type: "transport", error: te });
      throw te;
    }
  }
  setState(next) {
    this.state = next;
    this.stateQueue.publish(next);
  }
  tearDown(reason) {
    if (this.state.status === "closed")
      return;
    this.setState({ status: "closed", reason });
    const failure = reason.type === "shutdown" ? new ClientClosedError() : reason.error;
    for (const [id, pending] of this.pending) {
      if (pending.timer)
        clearTimeout(pending.timer);
      try {
        pending.reject(failure);
      } catch {
      }
      this.pending.delete(id);
    }
    for (const queue of this.subscriptions.values())
      queue.close();
    this.subscriptions.clear();
    this.allEvents.close();
    this.stateQueue.close();
  }
  async driveTransport() {
    try {
      while (this.state.status === "connected") {
        const frame = await this.transport.recv();
        if (frame === null) {
          this.tearDown({ type: "transport", error: new TransportError("closed", "transport closed") });
          return;
        }
        this.handleFrame(frame);
      }
    } catch (err) {
      const te = err instanceof TransportError ? err : new TransportError("io", `transport recv failed: ${err.message}`, { cause: err });
      this.tearDown({ type: "transport", error: te });
    }
  }
  handleFrame(frame) {
    let message;
    try {
      switch (frame.kind) {
        case "parsed":
          message = frame.message;
          break;
        case "text":
          message = decodeMessage(frame.text);
          break;
        case "binary": {
          const text = new TextDecoder("utf-8").decode(frame.data);
          message = decodeMessage(text);
          break;
        }
      }
    } catch (err) {
      console.warn(`AhpClient: malformed inbound frame: ${err.message}`);
      return;
    }
    this.dispatchInbound(message);
  }
  dispatchInbound(message) {
    if ("id" in message && "result" in message) {
      const success = message;
      const pending = this.pending.get(success.id);
      if (pending) {
        this.pending.delete(success.id);
        if (pending.timer)
          clearTimeout(pending.timer);
        pending.resolve(success.result);
      }
      return;
    }
    if ("id" in message && "error" in message) {
      const failure = message;
      const pending = this.pending.get(failure.id);
      if (pending) {
        this.pending.delete(failure.id);
        if (pending.timer)
          clearTimeout(pending.timer);
        pending.reject(new RpcError(failure.error.code, failure.error.message, failure.error.data));
      }
      return;
    }
    if ("id" in message && "method" in message) {
      void this.handleServerRequest(message);
      return;
    }
    if ("method" in message) {
      this.handleNotification(message);
      return;
    }
  }
  async handleServerRequest(req) {
    if (this.serverRequestHandler) {
      try {
        const handler = this.serverRequestHandler;
        const result = await handler(req.method, req.params);
        const response2 = {
          jsonrpc: "2.0",
          id: req.id,
          result
        };
        this.sendMessage(response2).catch(noop);
      } catch (err) {
        const code = err instanceof RpcError ? err.code : JsonRpcErrorCodes.InternalError;
        const message = err instanceof Error ? err.message : String(err);
        const data = err instanceof RpcError ? err.data : void 0;
        const response2 = {
          jsonrpc: "2.0",
          id: req.id,
          error: data !== void 0 ? { code, message, data } : { code, message }
        };
        this.sendMessage(response2).catch(noop);
      }
      return;
    }
    const response = {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: JsonRpcErrorCodes.MethodNotFound,
        message: `no handler for server method "${req.method}"`
      }
    };
    this.sendMessage(response).catch(noop);
  }
  handleNotification(n) {
    const params = n.params ?? {};
    const channel = params.channel;
    switch (n.method) {
      case "action": {
        const env = n.params;
        this.fanOut(env.channel, { type: "action", params: env });
        break;
      }
      case "root/sessionAdded": {
        const p = n.params;
        this.fanOut(p.channel, { type: "sessionAdded", params: p });
        break;
      }
      case "root/sessionRemoved": {
        const p = n.params;
        this.fanOut(p.channel, { type: "sessionRemoved", params: p });
        break;
      }
      case "root/sessionSummaryChanged": {
        const p = n.params;
        this.fanOut(p.channel, { type: "sessionSummaryChanged", params: p });
        break;
      }
      case "auth/required": {
        const p = n.params;
        this.fanOut(p.channel, { type: "authRequired", params: p });
        break;
      }
      default:
        void channel;
        break;
    }
  }
  fanOut(channel, event) {
    const queue = this.subscriptions.get(channel);
    if (queue)
      queue.publish(event);
    this.allEvents.publish({ channel, event });
  }
};

// node_modules/@microsoft/agent-host-protocol/dist/types/common/actions.js
var ActionType;
(function(ActionType2) {
  ActionType2["RootAgentsChanged"] = "root/agentsChanged";
  ActionType2["RootActiveSessionsChanged"] = "root/activeSessionsChanged";
  ActionType2["SessionReady"] = "session/ready";
  ActionType2["SessionCreationFailed"] = "session/creationFailed";
  ActionType2["SessionChatAdded"] = "session/chatAdded";
  ActionType2["SessionChatRemoved"] = "session/chatRemoved";
  ActionType2["SessionChatUpdated"] = "session/chatUpdated";
  ActionType2["SessionChatsReordered"] = "session/chatsReordered";
  ActionType2["SessionDefaultChatChanged"] = "session/defaultChatChanged";
  ActionType2["ChatTurnStarted"] = "chat/turnStarted";
  ActionType2["ChatDelta"] = "chat/delta";
  ActionType2["ChatResponsePart"] = "chat/responsePart";
  ActionType2["ChatToolCallStart"] = "chat/toolCallStart";
  ActionType2["ChatToolCallDelta"] = "chat/toolCallDelta";
  ActionType2["ChatToolCallReady"] = "chat/toolCallReady";
  ActionType2["ChatToolCallConfirmed"] = "chat/toolCallConfirmed";
  ActionType2["ChatToolCallComplete"] = "chat/toolCallComplete";
  ActionType2["ChatToolCallResultConfirmed"] = "chat/toolCallResultConfirmed";
  ActionType2["ChatToolCallContentChanged"] = "chat/toolCallContentChanged";
  ActionType2["ChatToolCallAuthRequired"] = "chat/toolCallAuthRequired";
  ActionType2["ChatToolCallAuthResolved"] = "chat/toolCallAuthResolved";
  ActionType2["ChatTurnComplete"] = "chat/turnComplete";
  ActionType2["ChatTurnCancelled"] = "chat/turnCancelled";
  ActionType2["ChatError"] = "chat/error";
  ActionType2["ChatTurnResume"] = "chat/turnResume";
  ActionType2["ChatActivityChanged"] = "chat/activityChanged";
  ActionType2["ChatBackgroundWorkSet"] = "chat/backgroundWorkSet";
  ActionType2["ChatBackgroundWorkRemoved"] = "chat/backgroundWorkRemoved";
  ActionType2["ChatMovableChanged"] = "chat/movableChanged";
  ActionType2["ChatChangesetsChanged"] = "chat/changesetsChanged";
  ActionType2["ChatCanvasesChanged"] = "chat/canvasesChanged";
  ActionType2["CanvasStateChanged"] = "canvas/stateChanged";
  ActionType2["ChatWorkingDirectorySet"] = "chat/workingDirectorySet";
  ActionType2["ChatWorkingDirectoryRemoved"] = "chat/workingDirectoryRemoved";
  ActionType2["SessionTitleChanged"] = "session/titleChanged";
  ActionType2["ChatUsage"] = "chat/usage";
  ActionType2["ChatReasoning"] = "chat/reasoning";
  ActionType2["SessionServerToolsChanged"] = "session/serverToolsChanged";
  ActionType2["SessionActiveClientSet"] = "session/activeClientSet";
  ActionType2["SessionActiveClientRemoved"] = "session/activeClientRemoved";
  ActionType2["SessionWorkingDirectorySet"] = "session/workingDirectorySet";
  ActionType2["SessionWorkingDirectoryRemoved"] = "session/workingDirectoryRemoved";
  ActionType2["SessionWorkingDirectoryReplaced"] = "session/workingDirectoryReplaced";
  ActionType2["SessionInputNeededSet"] = "session/inputNeededSet";
  ActionType2["SessionInputNeededRemoved"] = "session/inputNeededRemoved";
  ActionType2["ChatPendingMessageSet"] = "chat/pendingMessageSet";
  ActionType2["ChatPendingMessageRemoved"] = "chat/pendingMessageRemoved";
  ActionType2["ChatQueuedMessagesReordered"] = "chat/queuedMessagesReordered";
  ActionType2["ChatDraftChanged"] = "chat/draftChanged";
  ActionType2["ChatIsReadChanged"] = "chat/isReadChanged";
  ActionType2["ChatIsArchivedChanged"] = "chat/isArchivedChanged";
  ActionType2["ChatInputRequested"] = "chat/inputRequested";
  ActionType2["ChatInputAnswerChanged"] = "chat/inputAnswerChanged";
  ActionType2["ChatInputCompleted"] = "chat/inputCompleted";
  ActionType2["SessionCustomizationsChanged"] = "session/customizationsChanged";
  ActionType2["SessionCustomizationToggled"] = "session/customizationToggled";
  ActionType2["SessionCustomizationUpdated"] = "session/customizationUpdated";
  ActionType2["SessionCustomizationRemoved"] = "session/customizationRemoved";
  ActionType2["SessionMcpServerStateChanged"] = "session/mcpServerStateChanged";
  ActionType2["SessionMcpServerStartRequested"] = "session/mcpServerStartRequested";
  ActionType2["SessionMcpServerStopRequested"] = "session/mcpServerStopRequested";
  ActionType2["SessionMcpServerBackgroundRequested"] = "session/mcpServerBackgroundRequested";
  ActionType2["ChatTruncated"] = "chat/truncated";
  ActionType2["ChatTurnsLoaded"] = "chat/turnsLoaded";
  ActionType2["SessionIsReadChanged"] = "session/isReadChanged";
  ActionType2["SessionIsArchivedChanged"] = "session/isArchivedChanged";
  ActionType2["SessionActivityChanged"] = "session/activityChanged";
  ActionType2["SessionChangesetsChanged"] = "session/changesetsChanged";
  ActionType2["SessionConfigChanged"] = "session/configChanged";
  ActionType2["SessionMetaChanged"] = "session/metaChanged";
  ActionType2["ChangesetStatusChanged"] = "changeset/statusChanged";
  ActionType2["ChangesetFileSet"] = "changeset/fileSet";
  ActionType2["ChangesetFileRemoved"] = "changeset/fileRemoved";
  ActionType2["ChangesetFilesReviewChanged"] = "changeset/filesReviewChanged";
  ActionType2["ChangesetContentChanged"] = "changeset/contentChanged";
  ActionType2["ChangesetOperationsChanged"] = "changeset/operationsChanged";
  ActionType2["ChangesetOperationStatusChanged"] = "changeset/operationStatusChanged";
  ActionType2["ChangesetCleared"] = "changeset/cleared";
  ActionType2["AnnotationsSet"] = "annotations/set";
  ActionType2["AnnotationsUpdated"] = "annotations/updated";
  ActionType2["AnnotationsRemoved"] = "annotations/removed";
  ActionType2["AnnotationsEntrySet"] = "annotations/entrySet";
  ActionType2["AnnotationsEntryRemoved"] = "annotations/entryRemoved";
  ActionType2["RootTerminalsChanged"] = "root/terminalsChanged";
  ActionType2["RootConfigChanged"] = "root/configChanged";
  ActionType2["TerminalData"] = "terminal/data";
  ActionType2["TerminalInput"] = "terminal/input";
  ActionType2["TerminalResized"] = "terminal/resized";
  ActionType2["TerminalClaimed"] = "terminal/claimed";
  ActionType2["TerminalTitleChanged"] = "terminal/titleChanged";
  ActionType2["TerminalCwdChanged"] = "terminal/cwdChanged";
  ActionType2["TerminalExited"] = "terminal/exited";
  ActionType2["TerminalCleared"] = "terminal/cleared";
  ActionType2["TerminalCommandDetectionAvailable"] = "terminal/commandDetectionAvailable";
  ActionType2["TerminalCommandExecuted"] = "terminal/commandExecuted";
  ActionType2["TerminalCommandFinished"] = "terminal/commandFinished";
  ActionType2["ResourceWatchChanged"] = "resourceWatch/changed";
  ActionType2["AutomationCreateRequested"] = "automation/createRequested";
  ActionType2["AutomationUpdateRequested"] = "automation/updateRequested";
  ActionType2["AutomationSet"] = "automation/set";
  ActionType2["AutomationRemoved"] = "automation/removed";
  ActionType2["AutomationRunLifecycleChanged"] = "automationRun/lifecycleChanged";
  ActionType2["AutomationRunSessionSet"] = "automationRun/sessionSet";
  ActionType2["AutomationRunSessionRemoved"] = "automationRun/sessionRemoved";
  ActionType2["AutomationRunPrimarySessionChanged"] = "automationRun/primarySessionChanged";
  ActionType2["AutomationRunCancelRequested"] = "automationRun/cancelRequested";
})(ActionType || (ActionType = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-changeset/state.js
var ChangesetStatus;
(function(ChangesetStatus2) {
  ChangesetStatus2["Computing"] = "computing";
  ChangesetStatus2["Recomputing"] = "recomputing";
  ChangesetStatus2["Ready"] = "ready";
  ChangesetStatus2["Error"] = "error";
})(ChangesetStatus || (ChangesetStatus = {}));
var ChangesetOperationStatus;
(function(ChangesetOperationStatus2) {
  ChangesetOperationStatus2["Idle"] = "idle";
  ChangesetOperationStatus2["Running"] = "running";
  ChangesetOperationStatus2["Error"] = "error";
  ChangesetOperationStatus2["Disabled"] = "disabled";
})(ChangesetOperationStatus || (ChangesetOperationStatus = {}));
var ChangesetOperationScope;
(function(ChangesetOperationScope2) {
  ChangesetOperationScope2["Changeset"] = "changeset";
  ChangesetOperationScope2["Resource"] = "resource";
  ChangesetOperationScope2["Range"] = "range";
})(ChangesetOperationScope || (ChangesetOperationScope = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/action-origin.generated.js
var IS_CLIENT_DISPATCHABLE = {
  [ActionType.RootAgentsChanged]: false,
  [ActionType.RootActiveSessionsChanged]: false,
  [ActionType.RootTerminalsChanged]: false,
  [ActionType.RootConfigChanged]: true,
  [ActionType.SessionReady]: false,
  [ActionType.SessionCreationFailed]: false,
  [ActionType.SessionChatAdded]: false,
  [ActionType.SessionChatRemoved]: false,
  [ActionType.SessionChatUpdated]: false,
  [ActionType.SessionChatsReordered]: false,
  [ActionType.SessionDefaultChatChanged]: false,
  [ActionType.SessionTitleChanged]: true,
  [ActionType.SessionServerToolsChanged]: false,
  [ActionType.SessionActiveClientSet]: true,
  [ActionType.SessionActiveClientRemoved]: true,
  [ActionType.SessionWorkingDirectorySet]: true,
  [ActionType.SessionWorkingDirectoryRemoved]: true,
  [ActionType.SessionWorkingDirectoryReplaced]: true,
  [ActionType.SessionInputNeededSet]: false,
  [ActionType.SessionInputNeededRemoved]: false,
  [ActionType.SessionCustomizationsChanged]: false,
  [ActionType.SessionCustomizationToggled]: true,
  [ActionType.SessionCustomizationUpdated]: false,
  [ActionType.SessionCustomizationRemoved]: false,
  [ActionType.SessionMcpServerStateChanged]: false,
  [ActionType.SessionMcpServerStartRequested]: true,
  [ActionType.SessionMcpServerStopRequested]: true,
  [ActionType.SessionMcpServerBackgroundRequested]: true,
  [ActionType.SessionIsReadChanged]: true,
  [ActionType.SessionIsArchivedChanged]: true,
  [ActionType.SessionActivityChanged]: false,
  [ActionType.SessionChangesetsChanged]: false,
  [ActionType.SessionConfigChanged]: true,
  [ActionType.SessionMetaChanged]: false,
  [ActionType.ChatTurnStarted]: true,
  [ActionType.ChatDelta]: false,
  [ActionType.ChatResponsePart]: false,
  [ActionType.ChatToolCallStart]: false,
  [ActionType.ChatToolCallDelta]: false,
  [ActionType.ChatToolCallReady]: false,
  [ActionType.ChatToolCallConfirmed]: true,
  [ActionType.ChatToolCallComplete]: true,
  [ActionType.ChatToolCallResultConfirmed]: true,
  [ActionType.ChatToolCallContentChanged]: true,
  [ActionType.ChatToolCallAuthRequired]: false,
  [ActionType.ChatToolCallAuthResolved]: false,
  [ActionType.ChatTurnComplete]: false,
  [ActionType.ChatTurnCancelled]: true,
  [ActionType.ChatError]: false,
  [ActionType.ChatTurnResume]: true,
  [ActionType.ChatActivityChanged]: false,
  [ActionType.ChatBackgroundWorkSet]: false,
  [ActionType.ChatBackgroundWorkRemoved]: false,
  [ActionType.ChatMovableChanged]: false,
  [ActionType.ChatChangesetsChanged]: false,
  [ActionType.ChatCanvasesChanged]: false,
  [ActionType.CanvasStateChanged]: false,
  [ActionType.ChatWorkingDirectorySet]: true,
  [ActionType.ChatWorkingDirectoryRemoved]: true,
  [ActionType.ChatUsage]: false,
  [ActionType.ChatReasoning]: false,
  [ActionType.ChatPendingMessageSet]: true,
  [ActionType.ChatPendingMessageRemoved]: true,
  [ActionType.ChatQueuedMessagesReordered]: true,
  [ActionType.ChatDraftChanged]: true,
  [ActionType.ChatIsReadChanged]: true,
  [ActionType.ChatIsArchivedChanged]: true,
  [ActionType.ChatInputRequested]: false,
  [ActionType.ChatInputAnswerChanged]: true,
  [ActionType.ChatInputCompleted]: true,
  [ActionType.ChatTruncated]: true,
  [ActionType.ChatTurnsLoaded]: false,
  [ActionType.ChangesetStatusChanged]: false,
  [ActionType.ChangesetFileSet]: false,
  [ActionType.ChangesetFileRemoved]: false,
  [ActionType.ChangesetFilesReviewChanged]: true,
  [ActionType.ChangesetContentChanged]: false,
  [ActionType.ChangesetOperationsChanged]: false,
  [ActionType.ChangesetOperationStatusChanged]: false,
  [ActionType.ChangesetCleared]: false,
  [ActionType.AnnotationsSet]: true,
  [ActionType.AnnotationsUpdated]: true,
  [ActionType.AnnotationsRemoved]: true,
  [ActionType.AnnotationsEntrySet]: true,
  [ActionType.AnnotationsEntryRemoved]: true,
  [ActionType.TerminalData]: false,
  [ActionType.TerminalInput]: true,
  [ActionType.TerminalResized]: true,
  [ActionType.TerminalClaimed]: true,
  [ActionType.TerminalTitleChanged]: true,
  [ActionType.TerminalCwdChanged]: false,
  [ActionType.TerminalExited]: false,
  [ActionType.TerminalCleared]: true,
  [ActionType.TerminalCommandDetectionAvailable]: false,
  [ActionType.TerminalCommandExecuted]: false,
  [ActionType.TerminalCommandFinished]: false,
  [ActionType.ResourceWatchChanged]: false,
  [ActionType.AutomationCreateRequested]: true,
  [ActionType.AutomationUpdateRequested]: true,
  [ActionType.AutomationSet]: false,
  [ActionType.AutomationRemoved]: true,
  [ActionType.AutomationRunLifecycleChanged]: false,
  [ActionType.AutomationRunSessionSet]: false,
  [ActionType.AutomationRunSessionRemoved]: false,
  [ActionType.AutomationRunPrimarySessionChanged]: false,
  [ActionType.AutomationRunCancelRequested]: true
};

// node_modules/@microsoft/agent-host-protocol/dist/types/common/reducer-helpers.js
function softAssertNever(value, log) {
  const msg = `Unhandled action type: ${JSON.stringify(value)}`;
  (log ?? console.warn)(msg);
}

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-changeset/reducer.js
function changesetReducer(state, action, log) {
  switch (action.type) {
    case ActionType.ChangesetStatusChanged: {
      if (action.status === ChangesetStatus.Error) {
        return { ...state, status: action.status, error: action.error };
      }
      const { error: _ignored, ...rest } = state;
      return { ...rest, status: action.status };
    }
    case ActionType.ChangesetFileSet: {
      const idx = state.files.findIndex((f) => f.id === action.file.id);
      if (idx < 0) {
        return { ...state, files: [...state.files, action.file] };
      }
      const next = [...state.files];
      next[idx] = action.file;
      return { ...state, files: next };
    }
    case ActionType.ChangesetFileRemoved: {
      const idx = state.files.findIndex((f) => f.id === action.fileId);
      if (idx < 0) {
        return state;
      }
      const next = [...state.files];
      next.splice(idx, 1);
      return { ...state, files: next };
    }
    case ActionType.ChangesetFilesReviewChanged: {
      let changed = false;
      const ids = new Set(action.files);
      const next = state.files.map((f) => {
        if (!ids.has(f.id) || f.reviewed === action.reviewed) {
          return f;
        }
        changed = true;
        return { ...f, reviewed: action.reviewed };
      });
      return changed ? { ...state, files: next } : state;
    }
    case ActionType.ChangesetContentChanged: {
      return action.operations === void 0 ? { ...state, files: action.files } : { ...state, files: action.files, operations: action.operations };
    }
    case ActionType.ChangesetOperationsChanged: {
      if (action.operations === void 0) {
        const { operations: _ignored, ...rest } = state;
        return rest;
      }
      return { ...state, operations: action.operations };
    }
    case ActionType.ChangesetOperationStatusChanged: {
      if (state.operations === void 0) {
        return state;
      }
      const idx = state.operations.findIndex((o) => o.id === action.operationId);
      if (idx < 0) {
        return state;
      }
      const current = state.operations[idx];
      let nextOp;
      if (action.status === ChangesetOperationStatus.Error) {
        nextOp = { ...current, status: action.status, error: action.error };
      } else {
        const { error: _ignored, ...rest } = current;
        nextOp = { ...rest, status: action.status };
      }
      const next = [...state.operations];
      next[idx] = nextOp;
      return { ...state, operations: next };
    }
    case ActionType.ChangesetCleared:
      if (state.files.length === 0) {
        return state;
      }
      return { ...state, files: [] };
    default:
      softAssertNever(action, log);
      return state;
  }
}

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-session/state.js
var SessionLifecycle;
(function(SessionLifecycle2) {
  SessionLifecycle2["Creating"] = "creating";
  SessionLifecycle2["Ready"] = "ready";
  SessionLifecycle2["Failed"] = "failed";
})(SessionLifecycle || (SessionLifecycle = {}));
var SessionStatus;
(function(SessionStatus2) {
  SessionStatus2[SessionStatus2["Idle"] = 1] = "Idle";
  SessionStatus2[SessionStatus2["Error"] = 2] = "Error";
  SessionStatus2[SessionStatus2["InProgress"] = 8] = "InProgress";
  SessionStatus2[SessionStatus2["InputNeeded"] = 24] = "InputNeeded";
  SessionStatus2[SessionStatus2["IsRead"] = 32] = "IsRead";
  SessionStatus2[SessionStatus2["IsArchived"] = 64] = "IsArchived";
})(SessionStatus || (SessionStatus = {}));
var SessionOriginKind;
(function(SessionOriginKind2) {
  SessionOriginKind2["Automation"] = "automation";
})(SessionOriginKind || (SessionOriginKind = {}));
var SessionInputRequestKind;
(function(SessionInputRequestKind2) {
  SessionInputRequestKind2["ChatInput"] = "chatInput";
  SessionInputRequestKind2["ToolConfirmation"] = "toolConfirmation";
  SessionInputRequestKind2["ToolClientExecution"] = "toolClientExecution";
  SessionInputRequestKind2["ToolAuthentication"] = "toolAuthentication";
})(SessionInputRequestKind || (SessionInputRequestKind = {}));
var CustomizationType;
(function(CustomizationType2) {
  CustomizationType2["Plugin"] = "plugin";
  CustomizationType2["Directory"] = "directory";
  CustomizationType2["Agent"] = "agent";
  CustomizationType2["Skill"] = "skill";
  CustomizationType2["Prompt"] = "prompt";
  CustomizationType2["Rule"] = "rule";
  CustomizationType2["Hook"] = "hook";
  CustomizationType2["McpServer"] = "mcpServer";
})(CustomizationType || (CustomizationType = {}));
var CustomizationEnablementKind;
(function(CustomizationEnablementKind2) {
  CustomizationEnablementKind2["Global"] = "global";
  CustomizationEnablementKind2["Workspace"] = "workspace";
  CustomizationEnablementKind2["Session"] = "session";
})(CustomizationEnablementKind || (CustomizationEnablementKind = {}));
var CustomizationLoadStatus;
(function(CustomizationLoadStatus2) {
  CustomizationLoadStatus2["Loading"] = "loading";
  CustomizationLoadStatus2["Loaded"] = "loaded";
  CustomizationLoadStatus2["Degraded"] = "degraded";
  CustomizationLoadStatus2["Error"] = "error";
})(CustomizationLoadStatus || (CustomizationLoadStatus = {}));
var McpServerStatus;
(function(McpServerStatus2) {
  McpServerStatus2["Starting"] = "starting";
  McpServerStatus2["Ready"] = "ready";
  McpServerStatus2["AuthRequired"] = "authRequired";
  McpServerStatus2["Error"] = "error";
  McpServerStatus2["Stopped"] = "stopped";
})(McpServerStatus || (McpServerStatus = {}));
var McpAuthRequiredReason;
(function(McpAuthRequiredReason2) {
  McpAuthRequiredReason2["Required"] = "required";
  McpAuthRequiredReason2["Expired"] = "expired";
  McpAuthRequiredReason2["InsufficientScope"] = "insufficientScope";
})(McpAuthRequiredReason || (McpAuthRequiredReason = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-session/reducer.js
var STATUS_ACTIVITY_MASK = (1 << 5) - 1;
function withStatusFlag(status, flag, set) {
  return set ? status | flag : status & ~flag;
}
function awaitsUser(request) {
  return request.kind !== SessionInputRequestKind.ToolClientExecution;
}
function withInputNeededStatus(status, inputNeeded) {
  if (inputNeeded.some(awaitsUser)) {
    return status & ~STATUS_ACTIVITY_MASK | SessionStatus.InputNeeded;
  }
  return status & ~(SessionStatus.InputNeeded & ~SessionStatus.InProgress);
}
function updateMcpServerCustomization(state, id, update) {
  const list = state.customizations;
  if (!list) {
    return state;
  }
  const topIdx = list.findIndex((c) => c.id === id);
  if (topIdx >= 0) {
    const entry = list[topIdx];
    if (entry.type !== CustomizationType.McpServer) {
      return state;
    }
    const updated2 = list.slice();
    updated2[topIdx] = update(entry);
    return { ...state, customizations: updated2 };
  }
  let changed = false;
  const updated = list.map((container) => {
    if (container.type === CustomizationType.McpServer) {
      return container;
    }
    const children = container.children;
    if (!children) {
      return container;
    }
    const childIdx = children.findIndex((c) => c.id === id);
    if (childIdx < 0) {
      return container;
    }
    const child = children[childIdx];
    if (child.type !== CustomizationType.McpServer) {
      return container;
    }
    changed = true;
    const newChildren = children.slice();
    newChildren[childIdx] = update(child);
    return { ...container, children: newChildren };
  });
  if (!changed) {
    return state;
  }
  return { ...state, customizations: updated };
}
function applyCustomizationEnablement(customization, enablement) {
  switch (customization.type) {
    case CustomizationType.Plugin:
    case CustomizationType.McpServer: {
      if (enablement.length > 0) {
        return { ...customization, enablement: [...enablement] };
      }
      const { enablement: _enablement, ...withoutEnablement } = customization;
      return withoutEnablement;
    }
    default:
      return { ...customization, enabled: enablement[0]?.enabled ?? true };
  }
}
function sessionReducer(state, action, log) {
  switch (action.type) {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    case ActionType.SessionReady:
      return { ...state, lifecycle: SessionLifecycle.Ready };
    case ActionType.SessionCreationFailed:
      return {
        ...state,
        lifecycle: SessionLifecycle.Failed,
        creationError: action.error
      };
    case ActionType.SessionChatAdded: {
      const list = state.chats;
      const idx = list.findIndex((c) => c.resource === action.summary.resource);
      if (idx < 0) {
        return { ...state, chats: [...list, action.summary] };
      }
      const updated = list.slice();
      updated[idx] = action.summary;
      return { ...state, chats: updated };
    }
    case ActionType.SessionChatRemoved: {
      const list = state.chats;
      const idx = list.findIndex((c) => c.resource === action.chat);
      if (idx < 0) {
        return state;
      }
      const updated = list.slice();
      updated.splice(idx, 1);
      const next = { ...state, chats: updated };
      if (state.defaultChat === action.chat) {
        delete next.defaultChat;
      }
      return next;
    }
    case ActionType.SessionChatUpdated: {
      const list = state.chats;
      const idx = list.findIndex((c) => c.resource === action.chat);
      if (idx < 0) {
        return state;
      }
      const { resource: _ignored, ...changes } = action.changes;
      const updated = list.slice();
      updated[idx] = { ...list[idx], ...changes };
      return { ...state, chats: updated };
    }
    case ActionType.SessionChatsReordered: {
      const list = state.chats;
      if (action.chats.length !== list.length || new Set(action.chats).size !== list.length) {
        return state;
      }
      const summaries = new Map(list.map((summary) => [summary.resource, summary]));
      const reordered = [];
      for (const resource of action.chats) {
        const summary = summaries.get(resource);
        if (!summary) {
          return state;
        }
        reordered.push(summary);
      }
      if (reordered.every((summary, index) => summary === list[index])) {
        return state;
      }
      return { ...state, chats: reordered };
    }
    case ActionType.SessionDefaultChatChanged:
      return { ...state, defaultChat: action.defaultChat };
    // ── Metadata ──────────────────────────────────────────────────────────
    case ActionType.SessionTitleChanged:
      return { ...state, title: action.title };
    case ActionType.SessionIsReadChanged:
      return {
        ...state,
        status: withStatusFlag(state.status, SessionStatus.IsRead, action.isRead)
      };
    case ActionType.SessionIsArchivedChanged:
      return {
        ...state,
        status: withStatusFlag(state.status, SessionStatus.IsArchived, action.isArchived)
      };
    case ActionType.SessionActivityChanged:
      return { ...state, activity: action.activity };
    case ActionType.SessionChangesetsChanged: {
      const { changesets: _omit, ...stateWithoutChangesets } = state;
      return action.changesets ? { ...stateWithoutChangesets, changesets: action.changesets } : stateWithoutChangesets;
    }
    case ActionType.SessionConfigChanged:
      if (!state.config) {
        return state;
      }
      return {
        ...state,
        config: {
          ...state.config,
          values: action.replace ? { ...action.config } : { ...state.config.values, ...action.config }
        }
      };
    case ActionType.SessionMetaChanged:
      return { ...state, _meta: action._meta };
    case ActionType.SessionServerToolsChanged:
      return { ...state, serverTools: action.tools };
    case ActionType.SessionActiveClientSet: {
      const list = state.activeClients;
      const idx = list.findIndex((c) => c.clientId === action.activeClient.clientId);
      if (idx < 0) {
        return { ...state, activeClients: [...list, action.activeClient] };
      }
      const updated = list.slice();
      updated[idx] = action.activeClient;
      return { ...state, activeClients: updated };
    }
    case ActionType.SessionActiveClientRemoved: {
      const list = state.activeClients;
      const idx = list.findIndex((c) => c.clientId === action.clientId);
      if (idx < 0) {
        return state;
      }
      const updated = list.slice();
      updated.splice(idx, 1);
      return { ...state, activeClients: updated };
    }
    // ── Working Directories ─────────────────────────────────────────────
    case ActionType.SessionWorkingDirectorySet: {
      const list = state.workingDirectories ?? [];
      if (list.includes(action.directory)) {
        return state;
      }
      return { ...state, workingDirectories: [...list, action.directory] };
    }
    case ActionType.SessionWorkingDirectoryRemoved: {
      const list = state.workingDirectories;
      if (!list) {
        return state;
      }
      const idx = list.indexOf(action.directory);
      if (idx < 0) {
        return state;
      }
      const updated = list.slice();
      updated.splice(idx, 1);
      return { ...state, workingDirectories: updated };
    }
    case ActionType.SessionWorkingDirectoryReplaced: {
      const list = state.workingDirectories;
      if (!list) {
        return state;
      }
      const idx = list.indexOf(action.directory);
      if (idx < 0) {
        return state;
      }
      const replacementIdx = list.indexOf(action.replacement);
      if (replacementIdx >= 0 && replacementIdx < idx) {
        return {
          ...state,
          workingDirectories: list.filter((_, index) => index !== idx)
        };
      }
      return {
        ...state,
        workingDirectories: list.map((directory, index) => index === idx ? action.replacement : directory).filter((directory, index) => index === idx || directory !== action.replacement)
      };
    }
    // ── Input Needed ────────────────────────────────────────────────────
    case ActionType.SessionInputNeededSet: {
      const list = state.inputNeeded ?? [];
      const idx = list.findIndex((r) => r.id === action.request.id);
      const inputNeeded = idx < 0 ? [...list, action.request] : list.slice();
      if (idx >= 0) {
        inputNeeded[idx] = action.request;
      }
      return { ...state, inputNeeded, status: withInputNeededStatus(state.status, inputNeeded) };
    }
    case ActionType.SessionInputNeededRemoved: {
      const list = state.inputNeeded;
      if (!list) {
        return state;
      }
      const idx = list.findIndex((r) => r.id === action.id);
      if (idx < 0) {
        return state;
      }
      const remaining = list.slice();
      remaining.splice(idx, 1);
      const next = { ...state, status: withInputNeededStatus(state.status, remaining) };
      if (remaining.length > 0) {
        next.inputNeeded = remaining;
      } else {
        delete next.inputNeeded;
      }
      return next;
    }
    // ── Customizations ──────────────────────────────────────────────────
    case ActionType.SessionCustomizationsChanged:
      return { ...state, customizations: action.customizations };
    case ActionType.SessionCustomizationToggled: {
      const list = state.customizations;
      if (!list) {
        return state;
      }
      const topIdx = list.findIndex((c) => c.id === action.id);
      if (topIdx >= 0) {
        const updated = list.slice();
        updated[topIdx] = applyCustomizationEnablement(list[topIdx], action.enablement);
        return { ...state, customizations: updated };
      }
      for (let i = 0; i < list.length; i++) {
        const container = list[i];
        if (container.type === CustomizationType.McpServer) {
          continue;
        }
        const children = container.children;
        if (!children) {
          continue;
        }
        const childIdx = children.findIndex((c) => c.id === action.id);
        if (childIdx < 0) {
          continue;
        }
        const newChildren = children.slice();
        newChildren[childIdx] = applyCustomizationEnablement(children[childIdx], action.enablement);
        const updated = list.slice();
        updated[i] = { ...container, children: newChildren };
        return { ...state, customizations: updated };
      }
      return state;
    }
    case ActionType.SessionCustomizationUpdated: {
      const list = state.customizations ?? [];
      const idx = list.findIndex((c) => c.id === action.customization.id);
      if (idx < 0) {
        return { ...state, customizations: [...list, action.customization] };
      }
      const updated = [...list];
      updated[idx] = action.customization;
      return { ...state, customizations: updated };
    }
    case ActionType.SessionCustomizationRemoved: {
      const list = state.customizations;
      if (!list) {
        return state;
      }
      const topIdx = list.findIndex((c) => c.id === action.id);
      if (topIdx >= 0) {
        const updated2 = list.slice();
        updated2.splice(topIdx, 1);
        return { ...state, customizations: updated2 };
      }
      let changed = false;
      const updated = list.map((container) => {
        if (container.type === CustomizationType.McpServer) {
          return container;
        }
        const children = container.children;
        if (!children) {
          return container;
        }
        const childIdx = children.findIndex((c) => c.id === action.id);
        if (childIdx < 0) {
          return container;
        }
        changed = true;
        const newChildren = children.slice();
        newChildren.splice(childIdx, 1);
        return { ...container, children: newChildren };
      });
      if (!changed) {
        return state;
      }
      return { ...state, customizations: updated };
    }
    case ActionType.SessionMcpServerStateChanged: {
      return updateMcpServerCustomization(state, action.id, (entry) => ({
        ...entry,
        state: action.state,
        channel: action.channel
      }));
    }
    case ActionType.SessionMcpServerStartRequested: {
      return updateMcpServerCustomization(state, action.id, (entry) => ({
        ...entry,
        state: { kind: McpServerStatus.Starting },
        channel: void 0
      }));
    }
    case ActionType.SessionMcpServerBackgroundRequested: {
      return updateMcpServerCustomization(state, action.id, (entry) => entry.state.kind === McpServerStatus.Starting && entry.state.blocking ? { ...entry, state: { ...entry.state, blocking: false } } : entry);
    }
    case ActionType.SessionMcpServerStopRequested: {
      return updateMcpServerCustomization(state, action.id, (entry) => ({
        ...entry,
        state: { kind: McpServerStatus.Stopped },
        channel: void 0
      }));
    }
    default:
      softAssertNever(action, log);
      return state;
  }
}

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-terminal/state.js
var TerminalLifecycleStatus;
(function(TerminalLifecycleStatus2) {
  TerminalLifecycleStatus2["Running"] = "running";
  TerminalLifecycleStatus2["Exited"] = "exited";
})(TerminalLifecycleStatus || (TerminalLifecycleStatus = {}));
var TerminalClaimKind;
(function(TerminalClaimKind2) {
  TerminalClaimKind2["Client"] = "client";
  TerminalClaimKind2["Session"] = "session";
})(TerminalClaimKind || (TerminalClaimKind = {}));

// node_modules/@microsoft/agent-host-protocol/dist/ws/transport.js
var WebSocketTransport = class _WebSocketTransport {
  socket;
  inbox = [];
  waiters = [];
  closeInfo = null;
  error = null;
  closed = false;
  /**
   * Open a new WebSocket connection.
   *
   * Resolves once the socket emits `open`. Rejects with a
   * {@link TransportError} on early failure — either an `error` event or a
   * `close` event before `open`.
   */
  static connect(url, options = {}) {
    return new Promise((resolve, reject) => {
      const SocketCtor = globalThis.WebSocket;
      if (!SocketCtor) {
        reject(new TransportError("io", "global WebSocket is not available; install or polyfill it"));
        return;
      }
      let socket;
      try {
        socket = options.protocols !== void 0 ? new SocketCtor(url, options.protocols) : new SocketCtor(url);
      } catch (err) {
        reject(new TransportError("io", `failed to construct WebSocket: ${err.message}`, { cause: err }));
        return;
      }
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onErrorBeforeOpen);
        socket.removeEventListener("close", onCloseBeforeOpen);
      };
      const onOpen = () => {
        cleanup();
        resolve(new _WebSocketTransport(socket));
      };
      const onErrorBeforeOpen = () => {
        cleanup();
        reject(new TransportError("io", "websocket failed to open"));
      };
      const onCloseBeforeOpen = (ev) => {
        cleanup();
        reject(new TransportError("closed", `websocket closed before open (code=${ev.code})`));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onErrorBeforeOpen);
      socket.addEventListener("close", onCloseBeforeOpen);
    });
  }
  /**
   * Wrap an already-open WebSocket. Use this when you need to control
   * the handshake (custom subprotocols, query params, an existing
   * connection from another library).
   *
   * The socket MUST already be in the `OPEN` state.
   */
  static fromSocket(socket) {
    if (socket.readyState !== socket.OPEN) {
      throw new TransportError("io", "socket is not OPEN");
    }
    return new _WebSocketTransport(socket);
  }
  constructor(socket) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (ev) => {
      const data = ev.data;
      if (typeof data === "string") {
        this.deliver({ kind: "text", text: data });
      } else if (data instanceof ArrayBuffer) {
        this.deliver({ kind: "binary", data: new Uint8Array(data) });
      } else if (data instanceof Uint8Array) {
        this.deliver({ kind: "binary", data });
      } else {
        const err = new TransportError("protocol", "unsupported WebSocket message payload (expected string or ArrayBuffer)");
        this.error = err;
        this.drainWithError(err);
      }
    });
    socket.addEventListener("error", () => {
      this.error = new TransportError("io", "websocket error");
      this.drainWithError(this.error);
    });
    socket.addEventListener("close", (ev) => {
      this.closeInfo = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
      this.closed = true;
      if (!ev.wasClean) {
        const err = new TransportError("closed", `websocket closed abnormally (code=${ev.code})`);
        this.error = err;
        this.drainWithError(err);
      } else {
        this.drainWithNull();
      }
    });
  }
  /** Bytes still queued in the underlying socket's send buffer. */
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  /**
   * Information about the most recent close, set once the socket emits
   * `close`. `null` while the connection is open.
   */
  get lastClose() {
    return this.closeInfo;
  }
  send(message) {
    if (this.closed)
      throw new TransportError("closed", "transport closed");
    if (this.error)
      throw this.error;
    const payload = typeof message === "string" ? message : encodeMessage(message);
    try {
      this.socket.send(payload);
    } catch (err) {
      throw new TransportError("io", `websocket send failed: ${err.message}`, { cause: err });
    }
  }
  recv() {
    if (this.error)
      return Promise.reject(this.error);
    if (this.inbox.length > 0) {
      const frame = this.inbox.shift() ?? null;
      return Promise.resolve(frame);
    }
    if (this.closed)
      return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
  close() {
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      try {
        this.socket.close();
      } catch {
      }
    }
    return Promise.resolve();
  }
  deliver(frame) {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w)
        w.resolve(frame);
      return;
    }
    this.inbox.push(frame);
  }
  drainWithError(error) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters)
      w.reject(error);
  }
  drainWithNull() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters)
      w.resolve(null);
  }
};

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-root/state.js
var PolicyState;
(function(PolicyState2) {
  PolicyState2["Enabled"] = "enabled";
  PolicyState2["Disabled"] = "disabled";
  PolicyState2["Unconfigured"] = "unconfigured";
})(PolicyState || (PolicyState = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-chat/state.js
var BackgroundWorkKind;
(function(BackgroundWorkKind2) {
  BackgroundWorkKind2["Shell"] = "shell";
  BackgroundWorkKind2["Subagent"] = "subagent";
})(BackgroundWorkKind || (BackgroundWorkKind = {}));
var ChatOriginKind;
(function(ChatOriginKind2) {
  ChatOriginKind2["User"] = "user";
  ChatOriginKind2["Fork"] = "fork";
  ChatOriginKind2["SideChat"] = "sideChat";
  ChatOriginKind2["Tool"] = "tool";
})(ChatOriginKind || (ChatOriginKind = {}));
var ChatInteractivity;
(function(ChatInteractivity2) {
  ChatInteractivity2["Full"] = "full";
  ChatInteractivity2["ReadOnly"] = "read-only";
  ChatInteractivity2["Hidden"] = "hidden";
})(ChatInteractivity || (ChatInteractivity = {}));
var PendingMessageKind;
(function(PendingMessageKind2) {
  PendingMessageKind2["Steering"] = "steering";
  PendingMessageKind2["Queued"] = "queued";
})(PendingMessageKind || (PendingMessageKind = {}));
var ChatInputResponseKind;
(function(ChatInputResponseKind2) {
  ChatInputResponseKind2["Accept"] = "accept";
  ChatInputResponseKind2["Decline"] = "decline";
  ChatInputResponseKind2["Cancel"] = "cancel";
})(ChatInputResponseKind || (ChatInputResponseKind = {}));
var ChatInputQuestionKind;
(function(ChatInputQuestionKind2) {
  ChatInputQuestionKind2["Text"] = "text";
  ChatInputQuestionKind2["Number"] = "number";
  ChatInputQuestionKind2["Integer"] = "integer";
  ChatInputQuestionKind2["Boolean"] = "boolean";
  ChatInputQuestionKind2["SingleSelect"] = "single-select";
  ChatInputQuestionKind2["MultiSelect"] = "multi-select";
})(ChatInputQuestionKind || (ChatInputQuestionKind = {}));
var ChatInputAnswerValueKind;
(function(ChatInputAnswerValueKind2) {
  ChatInputAnswerValueKind2["Text"] = "text";
  ChatInputAnswerValueKind2["Number"] = "number";
  ChatInputAnswerValueKind2["Boolean"] = "boolean";
  ChatInputAnswerValueKind2["Selected"] = "selected";
  ChatInputAnswerValueKind2["SelectedMany"] = "selected-many";
})(ChatInputAnswerValueKind || (ChatInputAnswerValueKind = {}));
var ChatInputAnswerState;
(function(ChatInputAnswerState2) {
  ChatInputAnswerState2["Draft"] = "draft";
  ChatInputAnswerState2["Submitted"] = "submitted";
  ChatInputAnswerState2["Skipped"] = "skipped";
})(ChatInputAnswerState || (ChatInputAnswerState = {}));
var TurnState;
(function(TurnState2) {
  TurnState2["Complete"] = "complete";
  TurnState2["Cancelled"] = "cancelled";
  TurnState2["Error"] = "error";
})(TurnState || (TurnState = {}));
var MessageAttachmentKind;
(function(MessageAttachmentKind2) {
  MessageAttachmentKind2["Simple"] = "simple";
  MessageAttachmentKind2["EmbeddedResource"] = "embeddedResource";
  MessageAttachmentKind2["Resource"] = "resource";
  MessageAttachmentKind2["Annotations"] = "annotations";
  MessageAttachmentKind2["Chat"] = "chat";
})(MessageAttachmentKind || (MessageAttachmentKind = {}));
var MessageKind;
(function(MessageKind2) {
  MessageKind2["User"] = "user";
  MessageKind2["Agent"] = "agent";
  MessageKind2["Tool"] = "tool";
  MessageKind2["Automation"] = "automation";
  MessageKind2["SystemNotification"] = "systemNotification";
})(MessageKind || (MessageKind = {}));
var ResponsePartKind;
(function(ResponsePartKind2) {
  ResponsePartKind2["Markdown"] = "markdown";
  ResponsePartKind2["ContentRef"] = "contentRef";
  ResponsePartKind2["ToolCall"] = "toolCall";
  ResponsePartKind2["Reasoning"] = "reasoning";
  ResponsePartKind2["SystemNotification"] = "systemNotification";
  ResponsePartKind2["InputRequest"] = "inputRequest";
  ResponsePartKind2["Error"] = "error";
})(ResponsePartKind || (ResponsePartKind = {}));
var ToolCallStatus;
(function(ToolCallStatus2) {
  ToolCallStatus2["Streaming"] = "streaming";
  ToolCallStatus2["PendingConfirmation"] = "pending-confirmation";
  ToolCallStatus2["Running"] = "running";
  ToolCallStatus2["AuthRequired"] = "auth-required";
  ToolCallStatus2["PendingResultConfirmation"] = "pending-result-confirmation";
  ToolCallStatus2["Completed"] = "completed";
  ToolCallStatus2["Cancelled"] = "cancelled";
})(ToolCallStatus || (ToolCallStatus = {}));
var ToolCallConfirmationReason;
(function(ToolCallConfirmationReason2) {
  ToolCallConfirmationReason2["NotNeeded"] = "not-needed";
  ToolCallConfirmationReason2["UserAction"] = "user-action";
  ToolCallConfirmationReason2["Setting"] = "setting";
})(ToolCallConfirmationReason || (ToolCallConfirmationReason = {}));
var ToolCallRiskAssessmentKind;
(function(ToolCallRiskAssessmentKind2) {
  ToolCallRiskAssessmentKind2["Judge"] = "judge";
})(ToolCallRiskAssessmentKind || (ToolCallRiskAssessmentKind = {}));
var ToolCallRiskAssessmentStatus;
(function(ToolCallRiskAssessmentStatus2) {
  ToolCallRiskAssessmentStatus2["Loading"] = "loading";
  ToolCallRiskAssessmentStatus2["Complete"] = "complete";
})(ToolCallRiskAssessmentStatus || (ToolCallRiskAssessmentStatus = {}));
var ToolCallCancellationReason;
(function(ToolCallCancellationReason2) {
  ToolCallCancellationReason2["Denied"] = "denied";
  ToolCallCancellationReason2["Skipped"] = "skipped";
  ToolCallCancellationReason2["ResultDenied"] = "result-denied";
})(ToolCallCancellationReason || (ToolCallCancellationReason = {}));
var ConfirmationOptionKind;
(function(ConfirmationOptionKind2) {
  ConfirmationOptionKind2["Approve"] = "approve";
  ConfirmationOptionKind2["Deny"] = "deny";
})(ConfirmationOptionKind || (ConfirmationOptionKind = {}));
var ToolCallContributorKind;
(function(ToolCallContributorKind2) {
  ToolCallContributorKind2["Client"] = "client";
  ToolCallContributorKind2["MCP"] = "mcp";
})(ToolCallContributorKind || (ToolCallContributorKind = {}));
var ToolResultContentType;
(function(ToolResultContentType2) {
  ToolResultContentType2["Text"] = "text";
  ToolResultContentType2["EmbeddedResource"] = "embeddedResource";
  ToolResultContentType2["Resource"] = "resource";
  ToolResultContentType2["FileEdit"] = "fileEdit";
  ToolResultContentType2["Terminal"] = "terminal";
  ToolResultContentType2["Subagent"] = "subagent";
})(ToolResultContentType || (ToolResultContentType = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-resource-watch/state.js
var ResourceChangeType;
(function(ResourceChangeType2) {
  ResourceChangeType2["Added"] = "added";
  ResourceChangeType2["Updated"] = "updated";
  ResourceChangeType2["Deleted"] = "deleted";
})(ResourceChangeType || (ResourceChangeType = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-automation/state.js
var AutomationOperation;
(function(AutomationOperation2) {
  AutomationOperation2["Update"] = "update";
  AutomationOperation2["Remove"] = "remove";
  AutomationOperation2["Run"] = "run";
})(AutomationOperation || (AutomationOperation = {}));
var AutomationMisfirePolicy;
(function(AutomationMisfirePolicy2) {
  AutomationMisfirePolicy2["Skip"] = "skip";
  AutomationMisfirePolicy2["RunOnce"] = "runOnce";
})(AutomationMisfirePolicy || (AutomationMisfirePolicy = {}));
var AutomationTriggerKind;
(function(AutomationTriggerKind2) {
  AutomationTriggerKind2["Schedule"] = "schedule";
  AutomationTriggerKind2["Event"] = "event";
})(AutomationTriggerKind || (AutomationTriggerKind = {}));
var AutomationDisableConditionKind;
(function(AutomationDisableConditionKind2) {
  AutomationDisableConditionKind2["AfterRuns"] = "afterRuns";
  AutomationDisableConditionKind2["AfterDate"] = "afterDate";
})(AutomationDisableConditionKind || (AutomationDisableConditionKind = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-automation-run/state.js
var AutomationRunStatus;
(function(AutomationRunStatus2) {
  AutomationRunStatus2["Pending"] = "pending";
  AutomationRunStatus2["Running"] = "running";
  AutomationRunStatus2["Completed"] = "completed";
  AutomationRunStatus2["Failed"] = "failed";
  AutomationRunStatus2["Cancelled"] = "cancelled";
})(AutomationRunStatus || (AutomationRunStatus = {}));
var AutomationRunOriginKind;
(function(AutomationRunOriginKind2) {
  AutomationRunOriginKind2["Manual"] = "manual";
  AutomationRunOriginKind2["Trigger"] = "trigger";
})(AutomationRunOriginKind || (AutomationRunOriginKind = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/common/commands.js
var ReconnectResultType;
(function(ReconnectResultType2) {
  ReconnectResultType2["Replay"] = "replay";
  ReconnectResultType2["Snapshot"] = "snapshot";
})(ReconnectResultType || (ReconnectResultType = {}));
var ContentEncoding;
(function(ContentEncoding2) {
  ContentEncoding2["Base64"] = "base64";
  ContentEncoding2["Utf8"] = "utf-8";
})(ContentEncoding || (ContentEncoding = {}));
var ResourceWriteMode;
(function(ResourceWriteMode2) {
  ResourceWriteMode2["Truncate"] = "truncate";
  ResourceWriteMode2["Append"] = "append";
  ResourceWriteMode2["Insert"] = "insert";
})(ResourceWriteMode || (ResourceWriteMode = {}));
var ResourceType;
(function(ResourceType2) {
  ResourceType2["File"] = "file";
  ResourceType2["Directory"] = "directory";
  ResourceType2["Symlink"] = "symlink";
})(ResourceType || (ResourceType = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-session/commands.js
var CompletionItemKind;
(function(CompletionItemKind2) {
  CompletionItemKind2["UserMessage"] = "userMessage";
})(CompletionItemKind || (CompletionItemKind = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-chat/commands.js
var ChatSourceKind;
(function(ChatSourceKind2) {
  ChatSourceKind2["Fork"] = "fork";
  ChatSourceKind2["SideChat"] = "sideChat";
})(ChatSourceKind || (ChatSourceKind = {}));
var ChatMoveDestinationKind;
(function(ChatMoveDestinationKind2) {
  ChatMoveDestinationKind2["Session"] = "session";
  ChatMoveDestinationKind2["NewSession"] = "newSession";
})(ChatMoveDestinationKind || (ChatMoveDestinationKind = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-changeset/commands.js
var ChangesetOperationTargetKind;
(function(ChangesetOperationTargetKind2) {
  ChangesetOperationTargetKind2["Resource"] = "resource";
  ChangesetOperationTargetKind2["Range"] = "range";
})(ChangesetOperationTargetKind || (ChangesetOperationTargetKind = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/common/notifications.js
var AuthRequiredReason;
(function(AuthRequiredReason2) {
  AuthRequiredReason2["Required"] = "required";
  AuthRequiredReason2["Expired"] = "expired";
})(AuthRequiredReason || (AuthRequiredReason = {}));

// node_modules/@microsoft/agent-host-protocol/dist/types/version/registry.js
var SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "1.0.0",
  "0.9.0"
]);
var ACTION_INTRODUCED_IN = {
  [ActionType.RootAgentsChanged]: "0.1.0",
  [ActionType.RootActiveSessionsChanged]: "0.1.0",
  [ActionType.SessionReady]: "0.1.0",
  [ActionType.SessionCreationFailed]: "0.1.0",
  [ActionType.SessionChatAdded]: "0.4.0",
  [ActionType.SessionChatRemoved]: "0.4.0",
  [ActionType.SessionChatUpdated]: "0.4.0",
  [ActionType.SessionChatsReordered]: "0.9.0",
  [ActionType.SessionDefaultChatChanged]: "0.4.0",
  [ActionType.SessionTitleChanged]: "0.1.0",
  [ActionType.SessionServerToolsChanged]: "0.1.0",
  [ActionType.SessionActiveClientSet]: "0.5.0",
  [ActionType.SessionActiveClientRemoved]: "0.5.0",
  [ActionType.SessionWorkingDirectorySet]: "0.7.0",
  [ActionType.SessionWorkingDirectoryRemoved]: "0.7.0",
  [ActionType.SessionWorkingDirectoryReplaced]: "0.8.0",
  [ActionType.SessionInputNeededSet]: "0.5.1",
  [ActionType.SessionInputNeededRemoved]: "0.5.1",
  [ActionType.SessionCustomizationsChanged]: "0.1.0",
  [ActionType.SessionCustomizationToggled]: "0.1.0",
  [ActionType.SessionCustomizationUpdated]: "0.1.0",
  [ActionType.SessionCustomizationRemoved]: "0.2.0",
  [ActionType.SessionMcpServerStateChanged]: "0.3.0",
  [ActionType.SessionMcpServerStartRequested]: "0.5.2",
  [ActionType.SessionMcpServerStopRequested]: "0.5.2",
  [ActionType.SessionMcpServerBackgroundRequested]: "0.9.0",
  [ActionType.SessionIsReadChanged]: "0.1.0",
  [ActionType.SessionIsArchivedChanged]: "0.1.0",
  [ActionType.SessionActivityChanged]: "0.1.0",
  [ActionType.SessionChangesetsChanged]: "0.2.0",
  [ActionType.SessionConfigChanged]: "0.1.0",
  [ActionType.SessionMetaChanged]: "0.1.0",
  [ActionType.ChatTurnStarted]: "0.4.0",
  [ActionType.ChatDelta]: "0.4.0",
  [ActionType.ChatResponsePart]: "0.4.0",
  [ActionType.ChatToolCallStart]: "0.4.0",
  [ActionType.ChatToolCallDelta]: "0.4.0",
  [ActionType.ChatToolCallReady]: "0.4.0",
  [ActionType.ChatToolCallConfirmed]: "0.4.0",
  [ActionType.ChatToolCallComplete]: "0.4.0",
  [ActionType.ChatToolCallResultConfirmed]: "0.4.0",
  [ActionType.ChatToolCallContentChanged]: "0.4.0",
  [ActionType.ChatToolCallAuthRequired]: "0.6.0",
  [ActionType.ChatToolCallAuthResolved]: "0.6.0",
  [ActionType.ChatTurnComplete]: "0.4.0",
  [ActionType.ChatTurnCancelled]: "0.4.0",
  [ActionType.ChatError]: "0.4.0",
  [ActionType.ChatTurnResume]: "0.9.0",
  [ActionType.ChatActivityChanged]: "0.5.0",
  [ActionType.ChatBackgroundWorkSet]: "0.9.0",
  [ActionType.ChatBackgroundWorkRemoved]: "0.9.0",
  [ActionType.ChatMovableChanged]: "0.9.0",
  [ActionType.ChatChangesetsChanged]: "0.9.0",
  [ActionType.ChatCanvasesChanged]: "0.10.0",
  [ActionType.CanvasStateChanged]: "0.10.0",
  [ActionType.ChatWorkingDirectorySet]: "0.7.0",
  [ActionType.ChatWorkingDirectoryRemoved]: "0.7.0",
  [ActionType.ChatUsage]: "0.4.0",
  [ActionType.ChatReasoning]: "0.4.0",
  [ActionType.ChatPendingMessageSet]: "0.4.0",
  [ActionType.ChatPendingMessageRemoved]: "0.4.0",
  [ActionType.ChatQueuedMessagesReordered]: "0.4.0",
  [ActionType.ChatDraftChanged]: "0.5.0",
  [ActionType.ChatIsReadChanged]: "0.9.0",
  [ActionType.ChatIsArchivedChanged]: "0.9.0",
  [ActionType.ChatInputRequested]: "0.4.0",
  [ActionType.ChatInputAnswerChanged]: "0.4.0",
  [ActionType.ChatInputCompleted]: "0.4.0",
  [ActionType.ChatTruncated]: "0.4.0",
  [ActionType.ChatTurnsLoaded]: "0.5.1",
  [ActionType.ChangesetStatusChanged]: "0.2.0",
  [ActionType.ChangesetFileSet]: "0.2.0",
  [ActionType.ChangesetFileRemoved]: "0.2.0",
  [ActionType.ChangesetFilesReviewChanged]: "0.6.0",
  [ActionType.ChangesetContentChanged]: "0.4.0",
  [ActionType.ChangesetOperationsChanged]: "0.2.0",
  [ActionType.ChangesetOperationStatusChanged]: "0.3.0",
  [ActionType.ChangesetCleared]: "0.2.0",
  [ActionType.AnnotationsSet]: "0.4.0",
  [ActionType.AnnotationsUpdated]: "0.4.0",
  [ActionType.AnnotationsRemoved]: "0.4.0",
  [ActionType.AnnotationsEntrySet]: "0.4.0",
  [ActionType.AnnotationsEntryRemoved]: "0.4.0",
  [ActionType.RootTerminalsChanged]: "0.1.0",
  [ActionType.RootConfigChanged]: "0.1.0",
  [ActionType.TerminalData]: "0.1.0",
  [ActionType.TerminalInput]: "0.1.0",
  [ActionType.TerminalResized]: "0.1.0",
  [ActionType.TerminalClaimed]: "0.1.0",
  [ActionType.TerminalTitleChanged]: "0.1.0",
  [ActionType.TerminalCwdChanged]: "0.1.0",
  [ActionType.TerminalExited]: "0.1.0",
  [ActionType.TerminalCleared]: "0.1.0",
  [ActionType.TerminalCommandDetectionAvailable]: "0.1.0",
  [ActionType.TerminalCommandExecuted]: "0.1.0",
  [ActionType.TerminalCommandFinished]: "0.1.0",
  [ActionType.ResourceWatchChanged]: "0.2.0",
  [ActionType.AutomationCreateRequested]: "0.8.0",
  [ActionType.AutomationUpdateRequested]: "0.8.0",
  [ActionType.AutomationSet]: "0.8.0",
  [ActionType.AutomationRemoved]: "0.8.0",
  [ActionType.AutomationRunLifecycleChanged]: "0.8.0",
  [ActionType.AutomationRunSessionSet]: "0.8.0",
  [ActionType.AutomationRunSessionRemoved]: "0.8.0",
  [ActionType.AutomationRunPrimarySessionChanged]: "0.8.0",
  [ActionType.AutomationRunCancelRequested]: "0.8.0"
};

// node_modules/@microsoft/agent-host-protocol/dist/types/common/timestamps.js
function addMillisecondsToTimestamp(timestamp, duration) {
  return new Date(Date.parse(timestamp) + duration).toISOString();
}

// node_modules/@microsoft/agent-host-protocol/dist/types/channels-chat/reducer.js
function tcBase(tc) {
  return {
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    displayName: tc.displayName,
    intention: tc.intention,
    contributor: tc.contributor,
    _meta: tc._meta
  };
}
function tcBaseWithMeta(tc, meta) {
  return {
    ...tcBase(tc),
    _meta: meta ?? tc._meta
  };
}
function refineToolCallContributor(current, next, log) {
  if (!next) {
    return current;
  }
  if (current?.kind === ToolCallContributorKind.Client) {
    if (next.kind === ToolCallContributorKind.Client && next.clientId === current.clientId) {
      return next;
    }
    log?.(`Ignoring contributor change for client tool call from '${current.clientId}'`);
    return current;
  }
  if (next.kind === ToolCallContributorKind.Client) {
    log?.(`Ignoring late client contributor '${next.clientId}' because client execution ownership must be established at tool call start`);
    return current;
  }
  return next;
}
function resolveSelectedOption(options, id) {
  if (!id || !options) {
    return void 0;
  }
  return options.find((o) => o.id === id);
}
function hasBlockingToolCall(state) {
  if (!state.activeTurn) {
    return false;
  }
  return state.activeTurn.responseParts.some((part) => part.kind === ResponsePartKind.ToolCall && (part.toolCall.status === ToolCallStatus.PendingConfirmation || part.toolCall.status === ToolCallStatus.PendingResultConfirmation || part.toolCall.status === ToolCallStatus.AuthRequired));
}
function hasOpenInputRequest(state) {
  return state.activeTurn?.responseParts.some((part) => part.kind === ResponsePartKind.InputRequest && part.response === void 0) ?? false;
}
function findOpenInputRequestPart(responseParts, requestId) {
  const index = responseParts.findIndex((part2) => part2.kind === ResponsePartKind.InputRequest && part2.response === void 0 && part2.request.id === requestId);
  if (index < 0) {
    return void 0;
  }
  const part = responseParts[index];
  return part.kind === ResponsePartKind.InputRequest ? { index, part } : void 0;
}
function hasResumableError(turn) {
  const part = turn.responseParts[turn.responseParts.length - 1];
  return part?.kind === ResponsePartKind.Error && part.resumable === true;
}
function isErrorResponsePart(part) {
  return part.kind === ResponsePartKind.Error;
}
var STATUS_ACTIVITY_MASK2 = (1 << 5) - 1;
function withStatusFlag2(status, flag, set) {
  return set ? status | flag : status & ~flag;
}
function summaryStatus(state, terminalStatus) {
  let activity;
  if (terminalStatus) {
    activity = terminalStatus;
  } else if (hasOpenInputRequest(state) || hasBlockingToolCall(state)) {
    activity = SessionStatus.InputNeeded;
  } else if (state.activeTurn) {
    activity = SessionStatus.InProgress;
  } else {
    activity = SessionStatus.Idle;
  }
  return state.status & ~STATUS_ACTIVITY_MASK2 | activity;
}
function refreshSummaryStatus(state) {
  const status = summaryStatus(state);
  if (status === state.status) {
    return state;
  }
  return { ...state, status };
}
function endTurn(state, turnId, turnState, duration, terminalStatus, errorPart) {
  if (!state.activeTurn || state.activeTurn.id !== turnId) {
    return state;
  }
  const active = state.activeTurn;
  const responseParts = active.responseParts.map((part) => {
    if (part.kind !== ResponsePartKind.ToolCall) {
      return part;
    }
    const tc = part.toolCall;
    if (tc.status === ToolCallStatus.Completed || tc.status === ToolCallStatus.Cancelled) {
      return part;
    }
    return {
      kind: ResponsePartKind.ToolCall,
      toolCall: {
        status: ToolCallStatus.Cancelled,
        ...tcBase(tc),
        invocationMessage: tc.status === ToolCallStatus.Streaming ? tc.invocationMessage ?? "" : tc.invocationMessage,
        toolInput: tc.status === ToolCallStatus.Streaming ? void 0 : tc.toolInput,
        reason: ToolCallCancellationReason.Skipped
      }
    };
  });
  if (errorPart) {
    responseParts.push(errorPart);
  }
  const turn = {
    id: active.id,
    startedAt: active.startedAt,
    // Defensive clamp: the duration is producer-supplied and opaque to this
    // reducer, but a negative value would be nonsensical to display.
    duration: Math.max(0, duration),
    message: active.message,
    responseParts,
    usage: active.usage,
    state: turnState
  };
  const next = {
    ...state,
    turns: [...state.turns, turn],
    activeTurn: void 0,
    modifiedAt: addMillisecondsToTimestamp(active.startedAt, turn.duration ?? 0)
  };
  return {
    ...next,
    status: summaryStatus(next, terminalStatus)
  };
}
function upsertInputRequestPart(state, request) {
  const activeTurn = state.activeTurn;
  if (!activeTurn) {
    return state;
  }
  const existing = findOpenInputRequestPart(activeTurn.responseParts, request.id);
  const responseParts = [...activeTurn.responseParts];
  const part = {
    kind: ResponsePartKind.InputRequest,
    request
  };
  if (existing) {
    part.request = {
      ...request,
      answers: request.answers ?? existing.part.request.answers
    };
    responseParts[existing.index] = part;
  } else {
    responseParts.push(part);
  }
  const next = {
    ...state,
    activeTurn: {
      ...activeTurn,
      responseParts
    }
  };
  return { ...next, status: withStatusFlag2(summaryStatus(next), SessionStatus.IsRead, false) };
}
function updateToolCallInParts(state, turnId, toolCallId, updater) {
  const activeTurn = state.activeTurn;
  if (!activeTurn || activeTurn.id !== turnId) {
    return state;
  }
  let found = false;
  const responseParts = activeTurn.responseParts.map((part) => {
    if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId) {
      const updated = updater(part.toolCall);
      if (updated === part.toolCall) {
        return part;
      }
      found = true;
      return { ...part, toolCall: updated };
    }
    return part;
  });
  if (!found) {
    return state;
  }
  return {
    ...state,
    activeTurn: { ...activeTurn, responseParts }
  };
}
function updateResponsePart(state, turnId, partId, updater) {
  const activeTurn = state.activeTurn;
  if (!activeTurn || activeTurn.id !== turnId) {
    return state;
  }
  let found = false;
  const responseParts = activeTurn.responseParts.map((part) => {
    if (!found) {
      const id = part.kind === ResponsePartKind.ToolCall ? part.toolCall.toolCallId : "id" in part ? part.id : void 0;
      if (id === partId) {
        found = true;
        return updater(part);
      }
    }
    return part;
  });
  if (!found) {
    return state;
  }
  return {
    ...state,
    activeTurn: { ...activeTurn, responseParts }
  };
}
function chatReducer(state, action, log) {
  switch (action.type) {
    // ── Turn Lifecycle ────────────────────────────────────────────────────
    case ActionType.ChatTurnStarted: {
      let next = {
        ...state,
        activeTurn: {
          id: action.turnId,
          startedAt: action.startedAt,
          message: action.message,
          responseParts: [],
          usage: void 0
        }
      };
      next = {
        ...next,
        status: withStatusFlag2(summaryStatus(next), SessionStatus.IsRead, false),
        modifiedAt: action.startedAt
      };
      if (action.queuedMessageId) {
        if (next.steeringMessage?.id === action.queuedMessageId) {
          next = { ...next, steeringMessage: void 0 };
        }
        if (next.queuedMessages) {
          const filtered = next.queuedMessages.filter((m) => m.id !== action.queuedMessageId);
          next = { ...next, queuedMessages: filtered.length > 0 ? filtered : void 0 };
        }
      }
      return next;
    }
    case ActionType.ChatDelta:
      return updateResponsePart(state, action.turnId, action.partId, (part) => {
        if (part.kind === ResponsePartKind.Markdown) {
          return { ...part, content: part.content + action.content };
        }
        return part;
      });
    case ActionType.ChatResponsePart:
      if (!state.activeTurn || state.activeTurn.id !== action.turnId) {
        return state;
      }
      if (isErrorResponsePart(action.part)) {
        return state;
      }
      return {
        ...state,
        activeTurn: {
          ...state.activeTurn,
          responseParts: [...state.activeTurn.responseParts, action.part]
        }
      };
    case ActionType.ChatTurnComplete:
      return endTurn(state, action.turnId, TurnState.Complete, action.duration);
    case ActionType.ChatTurnCancelled:
      return endTurn(state, action.turnId, TurnState.Cancelled, action.duration);
    case ActionType.ChatError:
      return endTurn(state, action.turnId, TurnState.Error, action.duration, SessionStatus.Error, action.part);
    case ActionType.ChatTurnResume: {
      if (state.activeTurn) {
        return state;
      }
      const turnIndex = state.turns.length - 1;
      const turn = state.turns[turnIndex];
      if (!turn || turn.id !== action.turnId || turn.state !== TurnState.Error || !hasResumableError(turn)) {
        return state;
      }
      const turns = state.turns.slice();
      turns.splice(turnIndex, 1);
      const next = {
        ...state,
        turns,
        activeTurn: {
          id: turn.id,
          startedAt: turn.startedAt ?? state.modifiedAt,
          message: turn.message,
          responseParts: turn.responseParts,
          usage: turn.usage
        }
      };
      return {
        ...next,
        status: withStatusFlag2(summaryStatus(next), SessionStatus.IsRead, false)
      };
    }
    case ActionType.ChatActivityChanged:
      return { ...state, activity: action.activity };
    case ActionType.ChatBackgroundWorkSet: {
      const list = state.backgroundWork ?? [];
      const idx = list.findIndex((work) => work.id === action.work.id);
      const next = list.slice();
      if (idx < 0) {
        next.push(action.work);
      } else {
        next[idx] = action.work;
      }
      return { ...state, backgroundWork: next };
    }
    case ActionType.ChatBackgroundWorkRemoved: {
      const list = state.backgroundWork ?? [];
      const idx = list.findIndex((work) => work.id === action.id);
      if (idx < 0) {
        return state;
      }
      const next = list.slice();
      next.splice(idx, 1);
      return { ...state, backgroundWork: next };
    }
    case ActionType.ChatMovableChanged:
      return { ...state, movable: action.movable };
    case ActionType.ChatChangesetsChanged: {
      const { changesets: _omit, ...stateWithoutChangesets } = state;
      return action.changesets ? { ...stateWithoutChangesets, changesets: action.changesets } : stateWithoutChangesets;
    }
    case ActionType.ChatCanvasesChanged: {
      const { canvases: _omit, ...stateWithoutCanvases } = state;
      return action.canvases ? { ...stateWithoutCanvases, canvases: action.canvases } : stateWithoutCanvases;
    }
    // ── Working Directories ───────────────────────────────────────────────
    case ActionType.ChatWorkingDirectorySet: {
      const list = state.workingDirectories ?? [];
      if (list.includes(action.directory)) {
        return state;
      }
      return { ...state, workingDirectories: [...list, action.directory] };
    }
    case ActionType.ChatWorkingDirectoryRemoved: {
      const list = state.workingDirectories;
      if (!list) {
        return state;
      }
      const idx = list.indexOf(action.directory);
      if (idx < 0) {
        return state;
      }
      const updated = list.slice();
      updated.splice(idx, 1);
      return { ...state, workingDirectories: updated };
    }
    // ── Tool Call State Machine ───────────────────────────────────────────
    case ActionType.ChatToolCallStart:
      if (!state.activeTurn || state.activeTurn.id !== action.turnId) {
        return state;
      }
      return {
        ...state,
        activeTurn: {
          ...state.activeTurn,
          responseParts: [
            ...state.activeTurn.responseParts,
            {
              kind: ResponsePartKind.ToolCall,
              toolCall: {
                toolCallId: action.toolCallId,
                toolName: action.toolName,
                displayName: action.displayName,
                intention: action.intention,
                contributor: action.contributor,
                _meta: action._meta,
                status: ToolCallStatus.Streaming
              }
            }
          ]
        }
      };
    case ActionType.ChatToolCallDelta:
      return updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.Streaming) {
          return tc;
        }
        return {
          ...tc,
          ...action._meta !== void 0 ? { _meta: action._meta } : {},
          ...action.content !== void 0 ? { partialInput: (tc.partialInput ?? "") + action.content } : {},
          invocationMessage: action.invocationMessage ?? tc.invocationMessage
        };
      });
    case ActionType.ChatToolCallReady:
      return refreshSummaryStatus(updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.Streaming && tc.status !== ToolCallStatus.Running && tc.status !== ToolCallStatus.PendingConfirmation) {
          return tc;
        }
        const base = {
          ...tcBaseWithMeta(tc, action._meta),
          contributor: refineToolCallContributor(tc.contributor, action.contributor, log),
          intention: action.intention ?? tc.intention
        };
        const toolInput = action.toolInput ?? (tc.status === ToolCallStatus.Streaming ? void 0 : tc.toolInput);
        if (action.confirmed) {
          return {
            status: ToolCallStatus.Running,
            ...base,
            invocationMessage: action.invocationMessage,
            toolInput,
            confirmed: action.confirmed
          };
        }
        const pending = tc.status === ToolCallStatus.PendingConfirmation ? tc : void 0;
        const options = action.options ?? pending?.options;
        return {
          status: ToolCallStatus.PendingConfirmation,
          ...base,
          invocationMessage: action.invocationMessage,
          toolInput,
          confirmationTitle: action.confirmationTitle ?? pending?.confirmationTitle,
          riskAssessment: action.riskAssessment ?? pending?.riskAssessment,
          edits: action.edits ?? pending?.edits,
          editable: action.editable ?? pending?.editable,
          ...options ? { options } : {}
        };
      }));
    case ActionType.ChatToolCallConfirmed:
      return refreshSummaryStatus(updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.PendingConfirmation) {
          return tc;
        }
        const base = tcBaseWithMeta(tc, action._meta);
        const selectedOption = resolveSelectedOption(tc.options, action.selectedOptionId);
        if (action.approved) {
          const toolInput = action.editedToolInput !== void 0 && typeof tc.toolInput === "string" ? action.editedToolInput : tc.toolInput;
          return {
            status: ToolCallStatus.Running,
            ...base,
            invocationMessage: tc.invocationMessage,
            toolInput,
            confirmed: action.confirmed,
            ...selectedOption ? { selectedOption } : {}
          };
        }
        return {
          status: ToolCallStatus.Cancelled,
          ...base,
          invocationMessage: tc.invocationMessage,
          toolInput: tc.toolInput,
          reason: action.reason,
          reasonMessage: action.reasonMessage,
          userSuggestion: action.userSuggestion,
          ...selectedOption ? { selectedOption } : {}
        };
      }));
    case ActionType.ChatToolCallComplete:
      return refreshSummaryStatus(updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.Running && tc.status !== ToolCallStatus.PendingConfirmation && tc.status !== ToolCallStatus.AuthRequired) {
          return tc;
        }
        if (tc.status === ToolCallStatus.AuthRequired && action.result.success) {
          return tc;
        }
        const base = tcBaseWithMeta(tc, action._meta);
        const confirmed = tc.status === ToolCallStatus.Running || tc.status === ToolCallStatus.AuthRequired ? tc.confirmed : ToolCallConfirmationReason.NotNeeded;
        const selectedOption = tc.status === ToolCallStatus.Running || tc.status === ToolCallStatus.AuthRequired ? tc.selectedOption : void 0;
        const preAuthContent = tc.status === ToolCallStatus.AuthRequired ? tc.content : void 0;
        if (action.requiresResultConfirmation && tc.status !== ToolCallStatus.AuthRequired) {
          return {
            status: ToolCallStatus.PendingResultConfirmation,
            ...base,
            invocationMessage: tc.invocationMessage,
            toolInput: tc.toolInput,
            confirmed,
            ...selectedOption ? { selectedOption } : {},
            ...preAuthContent ? { content: preAuthContent } : {},
            ...action.result
          };
        }
        return {
          status: ToolCallStatus.Completed,
          ...base,
          invocationMessage: tc.invocationMessage,
          toolInput: tc.toolInput,
          confirmed,
          ...selectedOption ? { selectedOption } : {},
          ...preAuthContent ? { content: preAuthContent } : {},
          ...action.result
        };
      }));
    case ActionType.ChatToolCallResultConfirmed:
      return refreshSummaryStatus(updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.PendingResultConfirmation) {
          return tc;
        }
        const base = tcBaseWithMeta(tc, action._meta);
        if (action.approved) {
          return {
            status: ToolCallStatus.Completed,
            ...base,
            invocationMessage: tc.invocationMessage,
            toolInput: tc.toolInput,
            confirmed: tc.confirmed,
            ...tc.selectedOption ? { selectedOption: tc.selectedOption } : {},
            success: tc.success,
            pastTenseMessage: tc.pastTenseMessage,
            content: tc.content,
            structuredContent: tc.structuredContent,
            error: tc.error
          };
        }
        return {
          status: ToolCallStatus.Cancelled,
          ...base,
          invocationMessage: tc.invocationMessage,
          toolInput: tc.toolInput,
          reason: ToolCallCancellationReason.ResultDenied,
          ...tc.selectedOption ? { selectedOption: tc.selectedOption } : {}
        };
      }));
    case ActionType.ChatToolCallContentChanged:
      return updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.Running) {
          return tc;
        }
        return {
          ...tc,
          ...action._meta !== void 0 ? { _meta: action._meta } : {},
          content: action.content
        };
      });
    case ActionType.ChatToolCallAuthRequired:
      return refreshSummaryStatus(updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.Running) {
          return tc;
        }
        if (!tc.contributor || tc.contributor.kind !== ToolCallContributorKind.MCP) {
          return tc;
        }
        const base = tcBaseWithMeta(tc, action._meta);
        return {
          status: ToolCallStatus.AuthRequired,
          ...base,
          contributor: tc.contributor,
          invocationMessage: tc.invocationMessage,
          toolInput: tc.toolInput,
          confirmed: tc.confirmed,
          ...tc.selectedOption ? { selectedOption: tc.selectedOption } : {},
          ...tc.content ? { content: tc.content } : {},
          auth: action.auth
        };
      }));
    case ActionType.ChatToolCallAuthResolved:
      return refreshSummaryStatus(updateToolCallInParts(state, action.turnId, action.toolCallId, (tc) => {
        if (tc.status !== ToolCallStatus.AuthRequired) {
          return tc;
        }
        const base = tcBaseWithMeta(tc, action._meta);
        return {
          status: ToolCallStatus.Running,
          ...base,
          invocationMessage: tc.invocationMessage,
          toolInput: tc.toolInput,
          confirmed: tc.confirmed,
          ...tc.selectedOption ? { selectedOption: tc.selectedOption } : {},
          ...tc.content ? { content: tc.content } : {}
        };
      }));
    case ActionType.ChatUsage:
      if (!state.activeTurn || state.activeTurn.id !== action.turnId) {
        return state;
      }
      return {
        ...state,
        activeTurn: { ...state.activeTurn, usage: action.usage }
      };
    case ActionType.ChatReasoning:
      return updateResponsePart(state, action.turnId, action.partId, (part) => {
        if (part.kind === ResponsePartKind.Reasoning) {
          return { ...part, content: part.content + action.content };
        }
        return part;
      });
    // ── Truncation ────────────────────────────────────────────────────────
    case ActionType.ChatTruncated: {
      let turns;
      if (action.turnId === void 0) {
        turns = [];
      } else {
        const idx = state.turns.findIndex((t) => t.id === action.turnId);
        if (idx < 0) {
          return state;
        }
        turns = state.turns.slice(0, idx + 1);
      }
      const next = {
        ...state,
        turns,
        activeTurn: void 0
      };
      if (action.turnId === void 0) {
        delete next.turnsNextCursor;
      }
      return {
        ...next,
        status: summaryStatus(next)
      };
    }
    case ActionType.ChatTurnsLoaded: {
      const existingIds = new Set(state.turns.map((turn) => turn.id));
      const olderTurns = action.turns.filter((turn) => !existingIds.has(turn.id));
      return {
        ...state,
        turns: [...olderTurns, ...state.turns],
        turnsNextCursor: action.turnsNextCursor
      };
    }
    // ── Session Input Requests ─────────────────────────────────────────────
    case ActionType.ChatInputRequested:
      return upsertInputRequestPart(state, action.request);
    case ActionType.ChatInputAnswerChanged: {
      const activeTurn = state.activeTurn;
      const existing = activeTurn ? findOpenInputRequestPart(activeTurn.responseParts, action.requestId) : void 0;
      if (!activeTurn || !existing) {
        return state;
      }
      const { index, part } = existing;
      const request = part.request;
      const answers = { ...request.answers ?? {} };
      if (action.answer === void 0) {
        delete answers[action.questionId];
      } else {
        answers[action.questionId] = action.answer;
      }
      const responseParts = [...activeTurn.responseParts];
      responseParts[index] = {
        ...part,
        request: {
          ...request,
          answers: Object.keys(answers).length > 0 ? answers : void 0
        }
      };
      return {
        ...state,
        activeTurn: {
          ...activeTurn,
          responseParts
        }
      };
    }
    case ActionType.ChatInputCompleted: {
      const activeTurn = state.activeTurn;
      const existing = activeTurn ? findOpenInputRequestPart(activeTurn.responseParts, action.requestId) : void 0;
      if (!activeTurn || !existing) {
        return state;
      }
      const { index, part } = existing;
      const finalAnswers = { ...part.request.answers ?? {}, ...action.answers ?? {} };
      const responseParts = [...activeTurn.responseParts];
      responseParts[index] = {
        ...part,
        request: {
          ...part.request,
          answers: Object.keys(finalAnswers).length > 0 ? finalAnswers : void 0
        },
        response: action.response
      };
      const next = {
        ...state,
        activeTurn: {
          ...activeTurn,
          responseParts
        }
      };
      return {
        ...next,
        status: summaryStatus(next)
      };
    }
    // ── Pending Messages ──────────────────────────────────────────────────
    case ActionType.ChatPendingMessageSet: {
      const entry = { id: action.id, message: action.message };
      if (action.kind === PendingMessageKind.Steering) {
        return { ...state, steeringMessage: entry };
      }
      const existing = state.queuedMessages ?? [];
      const idx = existing.findIndex((m) => m.id === action.id);
      if (idx >= 0) {
        const updated = [...existing];
        updated[idx] = entry;
        return { ...state, queuedMessages: updated };
      }
      return { ...state, queuedMessages: [...existing, entry] };
    }
    case ActionType.ChatPendingMessageRemoved: {
      if (action.kind === PendingMessageKind.Steering) {
        if (!state.steeringMessage || state.steeringMessage.id !== action.id) {
          return state;
        }
        return { ...state, steeringMessage: void 0 };
      }
      const existing = state.queuedMessages;
      if (!existing) {
        return state;
      }
      const filtered = existing.filter((m) => m.id !== action.id);
      return filtered.length === existing.length ? state : { ...state, queuedMessages: filtered.length > 0 ? filtered : void 0 };
    }
    case ActionType.ChatQueuedMessagesReordered: {
      const existing = state.queuedMessages;
      if (!existing) {
        return state;
      }
      const byId = new Map(existing.map((m) => [m.id, m]));
      const ordered = /* @__PURE__ */ new Set();
      const reordered = action.order.filter((id) => {
        if (byId.has(id) && !ordered.has(id)) {
          ordered.add(id);
          return true;
        }
        return false;
      }).map((id) => byId.get(id));
      for (const m of existing) {
        if (!ordered.has(m.id)) {
          reordered.push(m);
        }
      }
      return { ...state, queuedMessages: reordered };
    }
    // ── Draft ─────────────────────────────────────────────────────────────
    case ActionType.ChatDraftChanged:
      return { ...state, draft: action.draft };
    case ActionType.ChatIsReadChanged:
      return { ...state, status: withStatusFlag2(state.status, SessionStatus.IsRead, action.isRead) };
    case ActionType.ChatIsArchivedChanged:
      return { ...state, status: withStatusFlag2(state.status, SessionStatus.IsArchived, action.isArchived) };
    default:
      softAssertNever(action, log);
      return state;
  }
}

// helper/connection.ts
var Connection = class extends EventEmitter {
  constructor(endpoint) {
    super();
    this.endpoint = endpoint;
  }
  client;
  states = /* @__PURE__ */ new Map();
  versions = /* @__PURE__ */ new Map();
  online = false;
  subscriptions = /* @__PURE__ */ new Set();
  sequences = /* @__PURE__ */ new Map();
  generation = 0;
  timer;
  stopped = false;
  delay = 500;
  async start() {
    const generation = ++this.generation;
    this.stopped = false;
    try {
      const transport = await WebSocketTransport.connect(this.endpoint);
      if (generation !== this.generation || this.stopped) {
        await transport.close();
        return;
      }
      const client = new AhpClient(transport, { requestTimeoutMs: 15e3 });
      this.client = client;
      client.connect();
      const events = client.events();
      void (async () => {
        for await (const { event } of events) {
          if (generation !== this.generation) break;
          if (event.type === "action") this.action(event.params);
        }
      })().catch((e) => this.emit("problem", e.message));
      await client.initialize({ clientId: `lookout-${crypto.randomUUID()}`, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
      for (const channel of this.subscriptions) await this.subscribe(channel);
      if (generation !== this.generation || this.stopped) return;
      this.online = true;
      this.delay = 500;
      this.emit("status", "connected");
      void (async () => {
        for await (const state of client.stateChanges()) if (state.status === "closed") {
          if (generation === this.generation && !this.stopped) this.retry();
          break;
        }
      })();
    } catch (error) {
      await this.client?.shutdown();
      this.emit("problem", "Connection failed. Check the host, port forward, and token.");
      if (!this.stopped && generation === this.generation) this.retry();
      throw new Error("Could not connect to the agent host");
    }
  }
  retry() {
    this.online = false;
    this.emit("status", "disconnected \u2014 reconnecting");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.start().catch(() => {
      });
    }, this.delay);
    this.delay = Math.min(this.delay * 2, 15e3);
  }
  snapshot(snapshot) {
    this.sequences.set(snapshot.resource, snapshot.fromSeq);
    this.states.set(snapshot.resource, snapshot.state);
    this.versions.set(snapshot.resource, (this.versions.get(snapshot.resource) ?? 0) + 1);
    this.emit("update", snapshot.resource);
  }
  action(envelope) {
    this.emit("action", envelope);
    if (envelope.rejectionReason) return;
    const { channel, action } = envelope;
    if (envelope.serverSeq <= (this.sequences.get(channel) ?? -1)) return;
    this.sequences.set(channel, envelope.serverSeq);
    const state = this.states.get(channel);
    if (!state) return;
    if (action.type.startsWith("chat/")) this.states.set(channel, chatReducer(state, action));
    else if (action.type.startsWith("changeset/")) this.states.set(channel, changesetReducer(state, action));
    else if (action.type.startsWith("session/")) this.states.set(channel, sessionReducer(state, action));
    this.versions.set(channel, (this.versions.get(channel) ?? 0) + 1);
    this.emit("update", channel);
  }
  async subscribe(channel, remember = true) {
    if (remember) this.subscriptions.add(channel);
    const { result } = await this.client.subscribe(channel);
    if (result.snapshot) this.snapshot(result.snapshot);
    return this.states.get(channel);
  }
  async unsubscribe(channel) {
    this.subscriptions.delete(channel);
    if (this.online) await this.client?.unsubscribe(channel);
    this.states.delete(channel);
  }
  async stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.online = false;
    await this.client?.shutdown();
  }
  dispatch(channel, action) {
    if (!this.online) throw new Error("Disconnected; feedback remains a draft");
    return this.client.dispatch(channel, action);
  }
};

// helper/review.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
var hash = (text) => createHash("sha256").update(text).digest("hex");
var same = (a, b) => a === null || b === null ? a === b : a.kind === b.kind && a.hash === b.hash;
var Review = class _Review {
  constructor(dir, identity, data) {
    this.dir = dir;
    this.data = data ?? { version: 1, identity, snapshot: "", files: [], checkpoints: {}, notes: [], draft: "", label: "" };
  }
  data;
  writing = Promise.resolve();
  static async load(dir, identity) {
    let data;
    try {
      data = JSON.parse(await readFile(join(dir, `${hash(identity)}.json`), "utf8"));
      if (data?.version !== 1 || data.identity !== identity || !Array.isArray(data.files) || !Array.isArray(data.notes)) throw new Error("Invalid review cache");
      if (data.delivery?.state === "pending") data.delivery = { ...data.delivery, state: "uncertain", reason: "Client closed before host acknowledgement; check the chat before resending." };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return new _Review(dir, identity, data);
  }
  save() {
    const content = JSON.stringify(this.data);
    const path = join(this.dir, `${hash(this.data.identity)}.json`);
    const task = this.writing.catch(() => {
    }).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 448 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 384 });
      await rename(temporary, path);
    });
    this.writing = task;
    return task;
  }
  async replace(files, label) {
    this.data.files = files;
    this.data.snapshot = randomUUID();
    this.data.label = label;
    await this.save();
  }
  visible(mode) {
    return this.data.files.map((file) => {
      const marked = Object.hasOwn(this.data.checkpoints, file.id);
      const baseline = mode === "since" && marked ? this.data.checkpoints[file.id] : file.before;
      return { ...file, before: baseline, seen: marked && same(this.data.checkpoints[file.id], file.after) };
    }).filter((file) => {
      if (file.removedFromChangeset && (mode === "all" || !Object.hasOwn(this.data.checkpoints, file.id))) return false;
      return file.before?.kind === "unavailable" || file.after?.kind === "unavailable" || !same(file.before, file.after);
    });
  }
  async seen(id) {
    const ids = Array.isArray(id) ? new Set(id) : void 0;
    const files = this.data.files.filter((file) => ids ? ids.has(file.id) : !id || file.id === id);
    if (files.some((file) => file.before?.kind === "unavailable" || file.after?.kind === "unavailable")) throw new Error("Cannot mark unavailable content seen");
    if (files.some((file) => file.after?.kind === "large")) throw new Error("Oversized files are metadata-only; their content cannot be checkpointed");
    for (const file of files) {
      this.data.checkpoints[file.id] = file.after;
    }
    await this.save();
  }
  async comment(input, mode) {
    if (!input.text.trim()) throw new Error("Comment is empty");
    const file = input.file ? this.visible(mode).find((x) => x.id === input.file) : void 0;
    if (input.file && !file) throw new Error("File is no longer displayed");
    const side = file?.[input.side ?? "after"];
    const first = input.first, last = input.last ?? first;
    if (first !== void 0 && (side?.kind !== "text" || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > side.text.split("\n").length)) throw new Error("Select a valid range in a text diff");
    this.data.notes.push({
      ...input,
      id: randomUUID(),
      snapshot: this.data.snapshot,
      path: file?.path,
      contentHash: side?.hash,
      quote: first === void 0 ? void 0 : side.text.split("\n").slice(first - 1, last).join("\n")
    });
    await this.save();
  }
  feedback() {
    if (this.data.draft) return this.data.draft;
    return this.data.notes.map((note) => {
      const where = note.path ? `${note.path}${note.first ? ` (${note.side ?? "after"} lines ${note.first}\u2013${note.last ?? note.first})` : ""}` : "General feedback";
      const older = note.snapshot !== this.data.snapshot ? " [earlier snapshot]" : "";
      return `${where}${older}
${note.text}${note.quote !== void 0 ? `

Snapshot context:
${note.quote.split("\n").map((line) => `> ${line}`).join("\n")}` : ""}`;
    }).join("\n\n---\n\n");
  }
};

// helper/controller.ts
var MAX_BYTES = 2 * 1024 * 1024;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var title = (text) => text.replace(/\s+/g, " ").slice(0, 140);
var Controller = class {
  constructor(emit) {
    this.emit = emit;
  }
  connection;
  review;
  target;
  mode = "since";
  status = "disconnected";
  dirty = false;
  profile;
  refreshing = false;
  refreshVersion = -1;
  pending;
  activityTimer;
  watches = [];
  state(uri) {
    return this.connection?.states.get(uri);
  }
  identity(target) {
    return JSON.stringify([this.profile.name, target.session, target.chat, target.changeset]);
  }
  lastPath() {
    return join2(this.profile.stateDir, `last-${hash(this.profile.name)}.json`);
  }
  activity() {
    const chat = this.target && this.state(this.target.chat);
    const session = this.target && this.state(this.target.session);
    return {
      status: this.status,
      dirty: this.dirty,
      host: this.profile?.name,
      target: this.target,
      activity: chat?.activity ?? (chat?.activeTurn ? "Working" : "Idle"),
      repository: (chat?.workingDirectories ?? session?.workingDirectories)?.join(", "),
      timeline: [...chat?.turns ?? [], ...chat?.activeTurn ? [chat.activeTurn] : []].slice(-30).reverse().map((turn) => ({
        id: turn.id,
        time: turn.startedAt,
        text: title(turn.message.text ?? ""),
        response: title(turn.responseParts.filter((p) => p.kind === "markdown").map((p) => "content" in p ? p.content : "").join(" ")),
        active: turn === chat?.activeTurn
      })),
      delivery: this.review?.data.delivery,
      notes: this.review?.data.notes.length ?? 0
    };
  }
  emitActivity() {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = void 0;
      this.emit("activity", this.activity());
    }, 100);
  }
  publish() {
    this.emit("view", {
      ...this.activity(),
      mode: this.mode,
      snapshot: this.review?.data.snapshot,
      files: this.review?.visible(this.mode) ?? [],
      notes: this.review?.data.notes ?? [],
      draft: this.review?.data.draft ?? ""
    });
  }
  async connect(profile) {
    await this.disconnect();
    this.target = void 0;
    this.review = void 0;
    this.watches = [];
    this.mode = "since";
    this.dirty = false;
    const endpoint = new URL(profile.url);
    if (!["ws:", "wss:"].includes(endpoint.protocol)) throw new Error("Host URL must use ws:// or wss://");
    this.profile = profile;
    this.publish();
    if (profile.token) endpoint.searchParams.set("tkn", profile.token);
    try {
      const last = JSON.parse(await readFile2(this.lastPath(), "utf8"));
      if (typeof last.session === "string" && typeof last.chat === "string" && typeof last.changeset === "string") {
        this.target = last;
        this.review = await Review.load(profile.stateDir, this.identity(last));
        this.dirty = true;
        this.publish();
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.emit("problem", "Could not restore the previous review; select a session to continue.");
    }
    const connection = new Connection(endpoint.href);
    this.connection = connection;
    connection.on("problem", (text) => this.emit("problem", text));
    connection.on("status", (status) => {
      this.status = status;
      if (!connection.online) {
        this.dirty = true;
        void this.uncertain("Connection lost; check the chat before resending.");
      } else if (this.target) void this.watchTarget().catch(() => {
      });
      this.emitActivity();
    });
    connection.on("action", (action) => {
      if (action.action.type === "resourceWatch/changed") {
        this.dirty = true;
        this.emitActivity();
      }
      void this.ack(action).catch((e) => this.emit("problem", e.message));
    });
    connection.on("update", (channel) => {
      if (channel === this.target?.changeset && (connection.versions.get(channel) ?? 0) !== this.refreshVersion) this.dirty = true;
      this.emitActivity();
    });
    try {
      await connection.start();
      if (this.target) {
        try {
          await this.subscribeTarget(this.target);
          await this.watchTarget();
          this.emitActivity();
        } catch {
          this.emit("problem", "Previous session is unavailable. Cached review is still readable; select another session to continue.");
        }
      }
    } catch {
      this.publish();
      throw new Error("Could not connect. Cached review remains available; reconnecting in the background.");
    }
    return { restored: Boolean(this.target) };
  }
  async disconnect() {
    await this.uncertain("Disconnected before acknowledgement; check the chat before resending.");
    await this.connection?.stop();
    clearTimeout(this.activityTimer);
    this.activityTimer = void 0;
    this.status = "disconnected";
    this.emitActivity();
  }
  online() {
    if (!this.connection?.online) throw new Error("Host is disconnected; the cached review is still readable");
    return this.connection;
  }
  async sessions() {
    const connection = this.online();
    const items = [];
    let cursor;
    do {
      const result = await connection.client.request("listSessions", { channel: "ahp-root://", limit: 100, cursor });
      items.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    return items;
  }
  async chats(session) {
    const state = await this.online().subscribe(session);
    return state.chats.filter((chat) => chat.interactivity !== "hidden");
  }
  async changesets(session, chat) {
    const connection = this.online();
    const state = await connection.subscribe(chat);
    const catalogue = [...state.changesets ?? [], ...this.state(session)?.changesets ?? []];
    const seen = /* @__PURE__ */ new Set();
    return catalogue.filter((entry) => !entry.uriTemplate.includes("{") && !seen.has(entry.uriTemplate) && Boolean(seen.add(entry.uriTemplate)));
  }
  async subscribeTarget(target) {
    const connection = this.online();
    await connection.subscribe(target.session);
    await connection.subscribe(target.chat);
    await connection.subscribe(target.changeset);
  }
  async watchTarget() {
    const connection = this.online();
    for (const channel of this.watches) await connection.unsubscribe(channel).catch(() => {
    });
    this.watches = [];
    if (!this.target) return;
    const chat = this.state(this.target.chat);
    const session = this.state(this.target.session);
    const directory = (chat?.workingDirectories ?? session?.workingDirectories)?.[0];
    if (!directory) return;
    try {
      const result = await connection.client.request("createResourceWatch", {
        channel: "ahp-root://",
        uri: directory,
        recursive: true,
        excludes: { items: ["**/.git/**", "**/node_modules/**", "**/.cache/**"] }
      });
      await connection.subscribe(result.channel, false);
      this.watches = [result.channel];
    } catch {
      this.emit("problem", "Filesystem watch unavailable. Agent events still update activity; use refresh to check for other edits.");
    }
  }
  async select(target) {
    if (this.pending) throw new Error("Wait for feedback delivery before switching reviews");
    await this.subscribeTarget(target);
    if (this.target) {
      const next = /* @__PURE__ */ new Set([target.session, target.chat, target.changeset]);
      for (const old of /* @__PURE__ */ new Set([this.target.session, this.target.chat, this.target.changeset])) {
        if (!next.has(old)) await this.connection.unsubscribe(old).catch(() => {
        });
      }
    }
    this.target = target;
    this.review = await Review.load(this.profile.stateDir, this.identity(target));
    await mkdir2(this.profile.stateDir, { recursive: true, mode: 448 });
    const path = this.lastPath();
    await writeFile2(`${path}.tmp`, JSON.stringify(target), { mode: 384 });
    await rename2(`${path}.tmp`, path);
    this.mode = "since";
    this.dirty = true;
    this.publish();
    await this.watchTarget();
    await this.refresh();
  }
  async side(side, missingAllowed = false) {
    if (!side) return null;
    const ref = side.content;
    if ((ref.sizeHint ?? 0) > MAX_BYTES) return { uri: side.uri, kind: "large", hash: `${ref.nonce ?? ""}:${ref.sizeHint}` };
    try {
      const result = await this.online().client.request("resourceRead", { channel: "ahp-root://", uri: ref.uri });
      const bytes = Buffer.from(result.data, result.encoding === "base64" ? "base64" : "utf8");
      const digest = hash(bytes.toString("base64"));
      if (bytes.length > MAX_BYTES) return { uri: side.uri, kind: "large", hash: digest };
      const mime = result.contentType ?? ref.contentType ?? "";
      if (bytes.includes(0) || /^(image|audio|video)\//.test(mime) || mime === "application/octet-stream") return { uri: side.uri, kind: "binary", hash: digest };
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { uri: side.uri, kind: "binary", hash: digest };
      }
      return { uri: side.uri, kind: "text", text, hash: digest };
    } catch (error) {
      if (missingAllowed && error.code === -32008) return null;
      return { uri: side.uri, kind: "unavailable", hash: "", error: "Content unavailable; retry refresh" };
    }
  }
  async refresh() {
    if (!this.target || !this.review) throw new Error("Select a review first");
    if (this.refreshing) throw new Error("A refresh is already running");
    const connection = this.online();
    this.refreshing = true;
    const target = this.target, review = this.review;
    try {
      await connection.subscribe(target.changeset);
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = this.state(target.changeset);
        if (!state || state.status !== "ready") {
          await sleep(200);
          continue;
        }
        const version = connection.versions.get(target.changeset);
        const files = [];
        for (let index = 0; index < state.files.length; index += 4) {
          files.push(...await Promise.all(state.files.slice(index, index + 4).map(async (entry) => ({
            id: entry.id,
            path: decodeURIComponent((entry.edit.after?.uri ?? entry.edit.before?.uri ?? entry.id).replace(/^file:\/\//, "")),
            before: await this.side(entry.edit.before),
            after: await this.side(entry.edit.after)
          }))));
        }
        for (const old of review.data.files) if (!files.some((file) => file.id === old.id)) {
          const uri = old.after?.uri ?? old.before?.uri;
          const after = uri ? await this.side({ uri, content: { uri } }, true) : null;
          files.push({ ...old, after, removedFromChangeset: true });
        }
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
        if (target !== this.target || review !== this.review) throw new Error("Review changed during refresh");
        if (!stable || version !== connection.versions.get(target.changeset)) {
          await sleep(150);
          continue;
        }
        this.refreshVersion = version ?? -1;
        await review.replace(files, target.label);
        this.dirty = this.refreshVersion !== connection.versions.get(target.changeset);
        this.publish();
        return;
      }
      throw new Error("Changes are still being computed or edited. Kept your previous snapshot; retry refresh shortly.");
    } finally {
      this.refreshing = false;
    }
  }
  async seen(id) {
    const review = this.requireReview();
    await review.seen(id ?? review.visible(this.mode).map((file) => file.id));
    this.publish();
  }
  view(mode) {
    this.mode = mode;
    this.publish();
  }
  requireReview() {
    if (!this.review) throw new Error("Select a review first");
    return this.review;
  }
  async comment(input) {
    const review = this.requireReview();
    if (input.snapshot && input.snapshot !== review.data.snapshot) throw new Error("Snapshot changed while composing the comment; select the context again");
    await review.comment(input, this.mode);
    this.publish();
  }
  async draft(text) {
    const review = this.requireReview();
    review.data.draft = text;
    await review.save();
  }
  feedback() {
    return this.requireReview().feedback();
  }
  async clearNotes() {
    const review = this.requireReview();
    review.data.notes = [];
    review.data.draft = "";
    await review.save();
    this.publish();
  }
  async send(text) {
    const connection = this.online(), review = this.requireReview();
    if (!text.trim()) throw new Error("Feedback is empty");
    if (this.pending) throw new Error("Feedback delivery is already pending");
    const chat = this.state(this.target.chat);
    if (!chat || chat.interactivity === "read-only" || chat.interactivity === "hidden") throw new Error("Selected chat does not accept feedback");
    const id = crypto.randomUUID();
    review.data.draft = text;
    review.data.delivery = { id, text, state: "pending" };
    await review.save();
    const action = chat.activeTurn ? { type: "chat/pendingMessageSet", kind: "steering", id, message: { text } } : { type: "chat/turnStarted", turnId: id, startedAt: (/* @__PURE__ */ new Date()).toISOString(), message: { text } };
    let dispatched;
    try {
      dispatched = connection.dispatch(this.target.chat, action);
    } catch (error) {
      review.data.delivery.state = "failed";
      review.data.delivery.reason = "Feedback could not be submitted; your draft is saved.";
      await review.save();
      this.publish();
      throw error;
    }
    this.pending = {
      id,
      clientSeq: dispatched.clientSeq,
      channel: this.target.chat,
      timer: setTimeout(() => {
        void this.uncertain("No host acknowledgement; check the chat before resending.");
      }, 2e4)
    };
    this.publish();
  }
  async ack(envelope) {
    const pending = this.pending;
    if (!pending || envelope.channel !== pending.channel) return;
    const action = envelope.action;
    const match = "id" in action && action.id === pending.id || "turnId" in action && action.turnId === pending.id;
    if (!match) return;
    clearTimeout(pending.timer);
    this.pending = void 0;
    const review = this.requireReview();
    const rejected = envelope.rejectionReason;
    review.data.delivery = { id: pending.id, text: review.data.delivery.text, state: rejected ? /uncertain/i.test(rejected) ? "uncertain" : "failed" : "accepted", reason: rejected };
    if (!rejected) {
      review.data.notes = [];
      review.data.draft = "";
    }
    await review.save();
    this.publish();
  }
  async uncertain(reason) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = void 0;
    if (this.review?.data.delivery) {
      this.review.data.delivery.state = "uncertain";
      this.review.data.delivery.reason = reason;
      await this.review.save();
      this.publish();
    }
  }
};
export {
  Controller
};
