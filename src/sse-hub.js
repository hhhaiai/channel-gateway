const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_QUEUE = 100;
const PAGE_SIZE = 500;

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function messageFrame(event) {
  return `event: message\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

class SseConnection {
  constructor({ response, maxQueue, remove }) {
    this.response = response;
    this.maxQueue = maxQueue;
    this.remove = remove;
    this.seen = new Set();
    this.replaying = true;
    this.queue = [];
    this.blocked = false;
    this.closed = false;

    this.onDrain = () => this.flush();
    this.onClose = () => this.close(false);
    response.on?.("drain", this.onDrain);
    response.on?.("close", this.onClose);
  }

  event(event) {
    if (
      this.closed ||
      !event ||
      typeof event.id !== "string" ||
      (this.replaying && this.seen.has(event.id))
    ) {
      return;
    }
    if (this.replaying) {
      this.seen.add(event.id);
    }
    this.send(messageFrame(event));
  }

  finishReplay() {
    this.seen.clear();
    this.replaying = false;
  }

  heartbeat() {
    if (!this.closed) {
      this.send(": heartbeat\n\n");
    }
  }

  send(frame) {
    if (this.blocked) {
      if (this.queue.length >= this.maxQueue) {
        this.close(true);
        return;
      }
      this.queue.push(frame);
      return;
    }

    try {
      this.blocked = this.response.write(frame) === false;
    } catch {
      this.close(true);
    }
  }

  flush() {
    if (this.closed) {
      return;
    }
    this.blocked = false;
    while (this.queue.length > 0 && !this.blocked) {
      const frame = this.queue.shift();
      try {
        this.blocked = this.response.write(frame) === false;
      } catch {
        this.close(true);
      }
    }
  }

  close(destroy) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.response.off?.("drain", this.onDrain);
    this.response.off?.("close", this.onClose);
    this.queue.length = 0;
    this.remove(this);

    if (!this.response.writableEnded && !this.response.destroyed) {
      if (destroy && typeof this.response.destroy === "function") {
        this.response.destroy();
      } else {
        this.response.end?.();
      }
    }
  }
}

export class SseHub {
  constructor({
    store,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    sseMaxQueue = DEFAULT_MAX_QUEUE,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    if (!store || typeof store.listPending !== "function") {
      throw new TypeError("store must implement listPending");
    }
    positiveInteger("heartbeatMs", heartbeatMs);
    positiveInteger("sseMaxQueue", sseMaxQueue);
    if (typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
      throw new TypeError("timer functions are required");
    }

    this.store = store;
    this.sseMaxQueue = sseMaxQueue;
    this.clearIntervalFn = clearIntervalFn;
    this.clients = new Set();
    this.closed = false;
    this.heartbeatTimer = setIntervalFn(() => {
      for (const client of this.clients) {
        client.heartbeat();
      }
    }, heartbeatMs);
    this.heartbeatTimer?.unref?.();
  }

  get clientCount() {
    return this.clients.size;
  }

  publish(event) {
    if (this.closed) {
      return;
    }
    for (const client of this.clients) {
      client.event(event);
    }
  }

  handle(request, response) {
    if (this.closed) {
      response.statusCode = 503;
      response.end?.();
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders?.();

    const client = new SseConnection({
      response,
      maxQueue: this.sseMaxQueue,
      remove: (connection) => this.clients.delete(connection),
    });

    // Subscribe before reading the durable snapshot. The per-client seen set
    // deduplicates an event published while listPending() is in progress.
    this.clients.add(client);
    request.on?.("aborted", () => client.close(false));
    try {
      let after;
      do {
        const page = this.store.listPending({ after, limit: PAGE_SIZE });
        for (const event of page.items) {
          client.event(event);
        }
        after = page.items.length === PAGE_SIZE ? page.nextAfter : undefined;
      } while (after && !client.closed);
      client.finishReplay();
    } catch {
      client.close(true);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearIntervalFn(this.heartbeatTimer);
    for (const client of [...this.clients]) {
      client.close(false);
    }
  }
}
