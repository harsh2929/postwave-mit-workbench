import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  PostwaveClient,
  PostwaveError,
  RequestAbortedError,
  ServerError,
} from "../src/index.js";
import { DECODE_WINDOW_BYTES, type EventRecord } from "../src/resources/events.js";
import { countAbortListeners } from "./lifecycle-helpers.js";

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(enc.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const enc = new TextEncoder();
const opened = { ts: "2026-05-19T00:00:00Z", event_type: "opened" };
const clicked = { ts: "2026-05-19T01:00:00Z", event_type: "clicked" };
const frame = (record: unknown) => `data: ${JSON.stringify(record)}\n\n`;

function bytesResponse(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" }, ...init },
  );
}

function clientWith(fetch: (url: string, init?: RequestInit) => Promise<Response>): PostwaveClient {
  return new PostwaveClient({ apiKey: "pw_key", tenantId: "tenant-one", fetch, retries: 0 });
}

function bytesClient(chunks: Uint8Array[]): PostwaveClient {
  return clientWith(async () => bytesResponse(chunks));
}

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/** A record whose `data: <json>` line is exactly `chars` characters long. */
function frameOfLength(chars: number, event_type: string): { line: string; record: EventRecord } {
  const build = (pad: string) => ({ ...opened, event_type, metadata: { pad } });
  const overhead = `data: ${JSON.stringify(build(""))}`.length;
  const record = build("x".repeat(chars - overhead));
  const line = `data: ${JSON.stringify(record)}`;
  expect(line.length).toBe(chars);
  return { line, record };
}

/** Delivers `first` (if any), then stalls forever, ignoring every signal. */
function stalledBody(first?: string, cancel?: () => Promise<void>) {
  const onCancel = vi.fn(() => cancel?.());
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first !== undefined) controller.enqueue(enc.encode(first));
    },
    cancel: onCancel,
  });
  return { body, onCancel };
}

/** Let pending I/O callbacks and microtasks run. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Observable parse work: JSON.parse calls whose input is exactly one of
 * `payloads`. The SDK parses each SSE frame's joined `data` value, or an
 * HTTP error body's text, once; so this counts how many fixture frames (or
 * error bodies) the stream has parsed. Exact matching matters: counting any
 * text that merely contains a fixture marker also counts unrelated parses,
 * such as the runner parsing this file's source map (which embeds the
 * marker) the first time it formats a stack trace.
 */
function countParses(payloads: Iterable<string>): { count: () => number; restore: () => void } {
  const expected = new Set(payloads);
  const spy = vi.spyOn(JSON, "parse");
  return {
    count: () => spy.mock.calls.filter(([text]) => typeof text === "string" && expected.has(text)).length,
    restore: () => spy.mockRestore(),
  };
}

/** The payload the SDK parses for each single-line `data: ` frame in `text`. */
function ssePayloads(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

/** The buffer and byte range a TextDecoder input covers, if it is a buffer. */
function byteRange(input: unknown): { buffer: ArrayBufferLike; start: number; end: number } | undefined {
  if (ArrayBuffer.isView(input)) {
    return { buffer: input.buffer, start: input.byteOffset, end: input.byteOffset + input.byteLength };
  }
  if (input instanceof ArrayBuffer) return { buffer: input, start: 0, end: input.byteLength };
  return undefined;
}

/**
 * Measures decoding work on fixture bytes. Every TextDecoder.decode input is
 * recorded by its underlying buffer and byte range, so `decodedBytes(chunk)`
 * counts how many bytes of that chunk's range were decoded, whether the SDK
 * passed the whole chunk, a subarray window of it or another view. Matching
 * by object identity is not enough: a windowed decoder never passes the
 * chunk object itself. Decoding a copy is invisible here, so tests pair this
 * with a positive control (full consumption decodes every byte once).
 */
function trackDecodes(): {
  decodedBytes: (chunk: Uint8Array) => number;
  decoded: (chunk: Uint8Array) => boolean;
  restore: () => void;
} {
  const spy = vi.spyOn(TextDecoder.prototype, "decode");
  const decodedBytes = (chunk: Uint8Array): number => {
    const start = chunk.byteOffset;
    const end = chunk.byteOffset + chunk.byteLength;
    let total = 0;
    for (const [input] of spy.mock.calls) {
      const range = byteRange(input);
      if (range && range.buffer === chunk.buffer) {
        total += Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
      }
    }
    return total;
  };
  return {
    decodedBytes,
    decoded: (chunk) => decodedBytes(chunk) > 0,
    restore: () => spy.mockRestore(),
  };
}

/**
 * A body whose reads each settle on their own macrotask, in `steps` order.
 * When the read for step `abortAt` settles, `abort()` is queued as a
 * microtask. The SDK's race on that read registered its reaction first, so
 * the read wins the race; the abort then runs before the SDK's code resumes
 * with the result. That is the "read settled just before the abort" window,
 * reached by job ordering alone, with no timing assumption.
 */
function settleThenAbortBody(steps: Array<Uint8Array | "close">, abortAt: number, abort: () => void) {
  let index = 0;
  const onCancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const step = steps[index];
          try {
            if (step === "close") controller.close();
            else if (step !== undefined) controller.enqueue(step);
          } catch {
            /* already cancelled by the SDK */
          }
          if (index++ === abortAt) queueMicrotask(abort);
          resolve();
        }, 0);
      });
    },
    cancel: onCancel,
  });
  return { body, onCancel };
}

/**
 * A native error body whose reader calls `onReleased` right after the SDK
 * releases it. The text-reading helper releases its reader in `finally`,
 * once the text is complete: its last synchronous step before its promise
 * settles. A microtask queued from there runs after the helper has finished,
 * but before its caller resumes, because the caller's continuation is only
 * queued when the helper returns. No hop counting or timing is involved.
 */
function errorBodyWithReleaseHook(chunk: Uint8Array, onReleased: () => void): ReadableStream<Uint8Array> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const getReader = body.getReader.bind(body);
  body.getReader = function hookedGetReader() {
    const reader = getReader();
    const releaseLock = reader.releaseLock.bind(reader);
    reader.releaseLock = () => {
      releaseLock();
      onReleased();
    };
    return reader;
  } as typeof body.getReader;
  return body;
}

/** A native body the test feeds one chunk at a time. */
function controlledBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const onCancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel: onCancel,
  });
  return {
    body,
    push: (text: string) => controller?.enqueue(enc.encode(text)),
    close: () => controller?.close(),
    error: (reason: unknown) => controller?.error(reason),
    onCancel,
  };
}

/**
 * One client for overlapping streams. Its transport hands each stream the
 * body registered for its `event_type` filter and records the signal the
 * SDK gave that request.
 */
function sharedClient(bodies: Record<string, ReadableStream<Uint8Array>>) {
  const transportSignals: Record<string, AbortSignal | undefined> = {};
  const client = clientWith(async (url, init) => {
    const key = new URL(url).searchParams.get("event_type") ?? "";
    const body = bodies[key];
    if (!body) throw new Error(`no fixture body for ${key}`);
    transportSignals[key] = init?.signal ?? undefined;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return { client, transportSignals };
}

const utf8Length = (text: string): number => enc.encode(text).byteLength;

/** Byte offset at which each of `frames` ends, laid end to end. */
function frameEnds(frames: string[]): number[] {
  let end = 0;
  return frames.map((text) => (end += utf8Length(text)));
}

/** Whether the byte at `offset` continues a multi-byte UTF-8 character. */
const isContinuationByte = (bytes: Uint8Array, offset: number): boolean =>
  ((bytes[offset] ?? 0) & 0xc0) === 0x80;

/**
 * A frame whose `text` run of `char` starts `shift` bytes before the next
 * decode-window boundary after `offset` (the frame's position in the
 * stream), so that boundary falls inside the first `char` when `shift` is
 * less than its byte length.
 */
function frameAcrossWindow(offset: number, char: string, shift: number, id: string): string {
  const build = (pad: number) =>
    frame({ ...opened, event_type: "utf8", id, metadata: { pad: "x".repeat(pad), text: char.repeat(4) } });
  const base = build(0);
  const charAt = offset + utf8Length(base.slice(0, base.indexOf(char)));
  const boundary = Math.ceil((charAt + shift + 1) / DECODE_WINDOW_BYTES) * DECODE_WINDOW_BYTES;
  return build(boundary - shift - charAt);
}

/**
 * A native body that delivers exactly these chunk objects. It then closes,
 * or with `live` stays open like a real event stream, so stopping early has
 * an open body to cancel.
 */
function nativeBody(chunks: unknown[], { live = false }: { live?: boolean } = {}) {
  const onCancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as Uint8Array);
      if (!live) controller.close();
    },
    cancel: onCancel,
  });
  return { body, onCancel };
}

/**
 * A `data:` line of exactly `units` UTF-16 code units (JavaScript string
 * length): the frame limit's unit. The pad is `char` repeated, with ASCII
 * filler first so the count can be hit exactly whatever `char`'s width.
 */
function lineOfUnits(units: number, char: string, id: string): { line: string; record: EventRecord } {
  const build = (pad: string) => ({ ...opened, event_type: "limit", id, metadata: { pad } });
  const base = `data: ${JSON.stringify(build(""))}`.length;
  const repeats = Math.floor((units - base) / char.length);
  const record = build("x".repeat(units - base - repeats * char.length) + char.repeat(repeats));
  const line = `data: ${JSON.stringify(record)}`;
  if (line.length !== units) throw new Error(`fixture: expected ${units} units, got ${line.length}`);
  return { line, record };
}

/** `parts` laid end to end in one new Uint8Array. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

/** `count` frames in one string; each record carries `marker` and its index as `id`. */
function bulkFrames(count: number, marker: string): string {
  let text = "";
  for (let i = 0; i < count; i++) text += frame({ ...opened, event_type: marker, id: `evt_${i}` });
  return text;
}

async function expectAborted(promise: Promise<unknown>, reason: unknown): Promise<void> {
  const err = await promise.then(
    () => expect.fail("expected the stream to reject"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RequestAbortedError);
  expect((err as RequestAbortedError).code).toBe("request_aborted");
  expect((err as RequestAbortedError).payload).toBe(reason);
}

describe("EventsResource.stream", () => {
  it("uses the configured fetch implementation and SDK auth headers", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'event: opened\n',
        'data: {"ts":"2026-05-19T00:00:00Z","event_type":"opened"}\n\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      defaultHeaders: { "X-Postwave-Client": "mobile" },
      fetch,
      retries: 0,
    });

    await expect(
      collect(pw.events.stream({ event_type: "opened", campaign: "cmp_1" })),
    ).resolves.toEqual([
      { ts: "2026-05-19T00:00:00Z", event_type: "opened" },
    ]);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/events/stream?event_type=opened&campaign=cmp_1",
      expect.objectContaining({
        method: "GET",
        credentials: undefined,
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer pw_key",
          "X-Tenant-Slug": "tenant-one",
          "X-Postwave-Client": "mobile",
        }),
      }),
    );
  });

  it("delivers the final SSE frame even when the stream closes without a blank separator", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'data: {"ts":"2026-05-19T01:00:00Z","event_type":"clicked"}\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      { ts: "2026-05-19T01:00:00Z", event_type: "clicked" },
    ]);
  });

  it("parses CRLF-delimited SSE frames", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        'event: clicked\r\ndata: {"ts":"2026-05-19T01:00:00Z","event_type":"clicked"}\r\n\r\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      { ts: "2026-05-19T01:00:00Z", event_type: "clicked" },
    ]);
  });

  it("skips malformed and shape-invalid SSE frames", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        "data: not-json\n\n",
        'data: {"ts":"2026-05-19T01:00:00Z"}\n\n',
        'data: {"ts":"2026-05-19T02:00:00Z","event_type":"opened","metadata":[]}\n\n',
        'data: {"ts":"2026-05-19T03:00:00Z","event_type":"opened","metadata":{"ok":true}}\n\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      {
        ts: "2026-05-19T03:00:00Z",
        event_type: "opened",
        metadata: { ok: true },
      },
    ]);
  });

  it("drops oversized stream frames and continues with later valid events", async () => {
    const fetch = vi.fn(async () =>
      sseResponse([
        `data: {"ts":"2026-05-19T00:00:00Z","event_type":"opened","metadata":{"blob":"${"x".repeat(300_000)}"}}\n\n`,
        'data: {"ts":"2026-05-19T04:00:00Z","event_type":"clicked"}\n\n',
      ]),
    );
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    await expect(collect(pw.events.stream())).resolves.toEqual([
      { ts: "2026-05-19T04:00:00Z", event_type: "clicked" },
    ]);
  });

  it("maps stream HTTP errors through the SDK error hierarchy", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: "missing_stream", message: "stream not found" },
        }),
        {
          status: 404,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_stream",
          },
        },
      );
    });
    const pw = new PostwaveClient({
      apiKey: "pw_key",
      tenantId: "tenant-one",
      fetch,
      retries: 0,
    });

    try {
      await collect(pw.events.stream());
      expect.fail("expected stream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as PostwaveError).code).toBe("missing_stream");
      expect((err as PostwaveError).requestId).toBe("req_stream");
    }
  });
});

describe("EventsResource.stream parsing across chunk boundaries", () => {
  it("delivers a CRLF multi-line frame split between CR and LF", async () => {
    const text = 'data: {"ts":"2026-05-19T00:00:00Z",\r\ndata: "event_type":"opened"}\r\n\r\n';
    const cr = text.indexOf("\r\n") + 1;
    await expect(
      collect(bytesClient([enc.encode(text.slice(0, cr)), enc.encode(text.slice(cr))]).events.stream()),
    ).resolves.toEqual([opened]);
  });

  it("yields the single-chunk result at every split point and chunk size", async () => {
    const unicode = { ...clicked, metadata: { label: "café 🌊" } };
    const bytes = enc.encode(
      [
        ": heartbeat\r\n",
        'event: opened\r\ndata: {"ts":"2026-05-19T00:00:00Z",\r\ndata: "event_type":"opened"}\r\n\r\n',
        "data: not-json\n\n",
        `data: ${JSON.stringify(unicode)}\r\r`,
        'id: 7\ndata: {"ts":"2026-05-19T00:00:00Z",\n: inline comment\ndata:\t"event_type":"opened"}\n\n',
        `data: ${JSON.stringify(clicked)}\n`,
      ].join(""),
    );
    const expected = [opened, unicode, opened, clicked];
    await expect(collect(bytesClient([bytes]).events.stream())).resolves.toEqual(expected);
    for (let at = 1; at < bytes.length; at++) {
      const got = await collect(bytesClient([bytes.slice(0, at), bytes.slice(at)]).events.stream());
      expect(got, `split at byte ${at}`).toEqual(expected);
    }
    for (const size of [1, 2, 3, 5, 7, 16]) {
      const got = await collect(bytesClient(chunked(bytes, size)).events.stream());
      expect(got, `${size}-byte chunks`).toEqual(expected);
    }
  });

  it("keeps a frame exactly at the 262,144-code-unit limit and drops one a unit over, however it is split", async () => {
    const limit = 256 * 1024;
    const atLimit = frameOfLength(limit, "at-limit");
    const overLimit = frameOfLength(limit + 1, "over-limit");
    const bytes = enc.encode(`${atLimit.line}\n\n${overLimit.line}\n\n${frame(clicked)}`);
    const terminator = atLimit.line.length + 1;
    for (const chunks of [
      [bytes],
      [bytes.slice(0, terminator), bytes.slice(terminator)],
      chunked(bytes, 4096),
      chunked(bytes, 4093),
    ]) {
      await expect(collect(bytesClient(chunks).events.stream())).resolves.toEqual([
        atLimit.record,
        clicked,
      ]);
    }
  });

  it("never parses the lines of an oversized frame as frames of their own", async () => {
    const phantom = { ...opened, event_type: "phantom" };
    const bytes = enc.encode(
      `data: ${"x".repeat(300_000)}\ndata: ${JSON.stringify(phantom)}\n\n${frame(clicked)}`,
    );
    for (const size of [bytes.length, 65_536, 4096, 1000]) {
      const got = await collect(bytesClient(chunked(bytes, size)).events.stream());
      expect(got, `${size}-byte chunks`).toEqual([clicked]);
    }
  });

  it("recovers after an unterminated oversized line and drops a frame still oversized at EOF", async () => {
    const huge = chunked(enc.encode(`: ${"y".repeat(600_000)}`), 8192);
    await expect(
      collect(bytesClient([...huge, enc.encode(`\n\n${frame(opened)}`)]).events.stream()),
    ).resolves.toEqual([opened]);

    const openAtEof = chunked(
      enc.encode(`data: ${"z".repeat(300_000)}\ndata: ${JSON.stringify(clicked)}`),
      8192,
    );
    await expect(
      collect(bytesClient([enc.encode(frame(opened)), ...openAtEof]).events.stream()),
    ).resolves.toEqual([opened]);
  });

  it("recovers from invalid UTF-8, field-less garbage and truncated JSON at the next frame", async () => {
    const chunks = [
      Uint8Array.of(0xff, 0xfe, 0x0a, 0x0a),
      enc.encode("garbage without a colon\n\u0000\u0001\n\n"),
      enc.encode('data: {"ts":"2026-05-19T00:00:00Z","event_type":\n\n'),
      Uint8Array.of(...enc.encode("data: "), 0xc3),
      enc.encode("\n\n" + frame(opened)),
    ];
    await expect(collect(bytesClient(chunks).events.stream())).resolves.toEqual([opened]);
  });
});

describe("EventsResource.stream cancellation and cleanup", () => {
  it("rejects an already-aborted signal without calling the transport", async () => {
    const fetch = vi.fn(async () => sseResponse([frame(opened)]));
    const controller = new AbortController();
    const reason = new Error("stop before start");
    controller.abort(reason);
    await expectAborted(collect(clientWith(fetch).events.stream({ signal: controller.signal })), reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ends a connect that the transport never settles, and cancels a body that arrives late", async () => {
    let resolveFetch: ((resp: Response) => void) | undefined;
    const fetch = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const pending = collect(clientWith(fetch).events.stream({ signal: controller.signal }));
    await tick(5);
    const reason = new Error("stop while connecting");
    controller.abort(reason);
    await expectAborted(pending, reason);

    const transportSignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(transportSignal?.aborted).toBe(true);
    expect(transportSignal?.reason).toBe(reason);
    expect(listeners()).toBe(0);

    const late = stalledBody(frame(opened));
    resolveFetch?.(new Response(late.body));
    await tick();
    expect(late.onCancel).toHaveBeenCalledTimes(1);
  });

  it("ends a stalled read of a body that ignores the signal", async () => {
    const stalled = stalledBody(frame(opened));
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const iterator = clientWith(async () => new Response(stalled.body))
      .events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: opened });
    const next = iterator.next();
    await tick(5);
    controller.abort("stop while reading");
    await expectAborted(next, "stop while reading");
    expect(stalled.onCancel).toHaveBeenCalledTimes(1);
    expect(stalled.body.locked).toBe(false);
    expect(listeners()).toBe(0);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("releases the body as soon as the caller aborts while holding an event, and yields nothing more", async () => {
    const stalled = stalledBody(frame(opened) + frame(clicked));
    const controller = new AbortController();
    const iterator = clientWith(async () => new Response(stalled.body))
      .events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: opened });
    controller.abort("stop between events");
    expect(stalled.onCancel).toHaveBeenCalledTimes(1);
    expect(stalled.body.locked).toBe(false);
    await expectAborted(iterator.next(), "stop between events");
  });

  it("returns from break promptly even when the body's cancel() never settles", async () => {
    const stalled = stalledBody(frame(opened), () => new Promise<void>(() => {}));
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(stalled.body));
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    for await (const record of clientWith(fetch).events.stream({ signal: controller.signal })) {
      expect(record).toEqual(opened);
      break;
    }
    expect(stalled.onCancel).toHaveBeenCalledTimes(1);
    expect(stalled.body.locked).toBe(false);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(listeners()).toBe(0);
  });

  it("leaves no listener and does not abort the transport when the stream ends normally", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([frame(opened)]));
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    await expect(
      collect(clientWith(fetch).events.stream({ signal: controller.signal })),
    ).resolves.toEqual([opened]);
    expect(listeners()).toBe(0);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("surfaces a dropped connection's error unchanged and releases the reader", async () => {
    const dropped = new TypeError("connection reset");
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(enc.encode(frame(opened)));
        else controller.error(dropped);
      },
    });
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const received: EventRecord[] = [];
    await expect(
      (async () => {
        for await (const record of clientWith(async () => new Response(body)).events.stream({
          signal: controller.signal,
        })) {
          received.push(record);
        }
      })(),
    ).rejects.toBe(dropped);
    expect(received).toEqual([opened]);
    expect(body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });
});

describe("EventsResource.stream error-response cleanup", () => {
  it("maps the status and unlocks the body when the error body fails mid-read", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("body failed"));
      },
    });
    const err = await collect(
      clientWith(async () => new Response(body, { status: 500, headers: { "x-request-id": "req_stream" } }))
        .events.stream(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).requestId).toBe("req_stream");
    expect(body.locked).toBe(false);
  });

  it("cancels and unlocks an error body over 64 KiB, by streamed size or content-length", async () => {
    const onCancel = vi.fn();
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(70_000));
      },
      cancel: onCancel,
    });
    await expect(
      collect(clientWith(async () => new Response(streamed, { status: 500 })).events.stream()),
    ).rejects.toBeInstanceOf(ServerError);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(streamed.locked).toBe(false);

    const declared = stalledBody("{}");
    await expect(
      collect(
        clientWith(
          async () => new Response(declared.body, { status: 502, headers: { "content-length": "999999" } }),
        ).events.stream(),
      ),
    ).rejects.toBeInstanceOf(ServerError);
    expect(declared.onCancel).toHaveBeenCalledTimes(1);
    expect(declared.body.locked).toBe(false);
  });

  it("rejects and cancels the body when the caller aborts a stalled error-body read", async () => {
    const stalled = stalledBody('{"error":');
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const pending = collect(
      clientWith(
        async () =>
          new Response(stalled.body, { status: 503, headers: { "content-type": "application/json" } }),
      ).events.stream({ signal: controller.signal }),
    );
    await tick(5);
    controller.abort("stop during error body");
    await expectAborted(pending, "stop during error body");
    expect(stalled.onCancel).toHaveBeenCalledTimes(1);
    expect(stalled.body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });
});

describe("EventsResource.stream abort windows", () => {
  it.each([200, 500])(
    "cancels the body when the abort lands after the transport resolves but before it is read (HTTP %i)",
    async (status) => {
      const onCancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(frame(opened)));
        },
        cancel: onCancel,
      });
      const controller = new AbortController();
      const listeners = countAbortListeners(controller.signal);
      // Resolve, then abort one microtask later: after the SDK has the
      // response, before its continuation attaches a reader or reads.
      const fetch = () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(new Response(body, { status }));
            queueMicrotask(() => controller.abort("abort before reader"));
          }, 0);
        });
      await expectAborted(
        collect(clientWith(fetch).events.stream({ signal: controller.signal })),
        "abort before reader",
      );
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(listeners()).toBe(0);
    },
  );

  it("rejects the next next() when the caller aborts after the final end-of-stream event", async () => {
    for (const text of [`data: ${JSON.stringify(clicked)}`, frame(clicked)]) {
      const controller = new AbortController();
      const listeners = countAbortListeners(controller.signal);
      const iterator = bytesClient([enc.encode(text)])
        .events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ done: false, value: clicked });
      controller.abort("abort after last event");
      await expectAborted(iterator.next(), "abort after last event");
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      expect(listeners()).toBe(0);
    }
  });

  it("ends quietly and releases the body on break after an abort in the loop body", async () => {
    const stalled = stalledBody(frame(opened) + frame(clicked));
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const received: EventRecord[] = [];
    for await (const record of clientWith(async () => new Response(stalled.body)).events.stream({
      signal: controller.signal,
    })) {
      received.push(record);
      controller.abort("abort then break");
      break;
    }
    expect(received).toEqual([opened]);
    expect(stalled.onCancel).toHaveBeenCalledTimes(1);
    expect(stalled.body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });

  it("still completes normally after the final end-of-stream event when nothing aborts", async () => {
    const controller = new AbortController();
    const iterator = bytesClient([enc.encode(`data: ${JSON.stringify(clicked)}`)])
      .events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: clicked });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    controller.abort("abort after completion");
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

describe("EventsResource.stream demand-driven parsing", () => {
  it("parses a 10,000-event chunk one frame per next(), and not past a break", async () => {
    const text = bulkFrames(10_000, "bulk-demand");
    const onCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(text));
      },
      cancel: onCancel,
    });
    const parses = countParses(ssePayloads(text));
    try {
      const iterator = clientWith(async () => new Response(body)).events.stream()[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) {
        const { value } = await iterator.next();
        expect(value?.id).toBe(`evt_${i}`);
        expect(parses.count(), `frames parsed after next() #${i + 1}`).toBe(i + 1);
      }
      await iterator.return?.();
      expect(parses.count()).toBe(3);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    } finally {
      parses.restore();
    }
  });

  it("stops parsing a large chunk where the caller aborts", async () => {
    const text = bulkFrames(10_000, "bulk-abort");
    const controller = new AbortController();
    const parses = countParses(ssePayloads(text));
    try {
      const iterator = bytesClient([enc.encode(text)])
        .events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.id).toBe("evt_0");
      controller.abort("abort mid-chunk");
      await expectAborted(iterator.next(), "abort mid-chunk");
      expect(parses.count()).toBe(1);
    } finally {
      parses.restore();
    }
  });

  it("skips frames that yield no record within the same next(), and parses no further", async () => {
    const marker = "bulk-skip";
    const invalid = [
      `data: {"${marker}":\n\n`,
      frame({ ts: opened.ts, note: marker }),
      frame({ ...opened, event_type: marker, metadata: [] }),
    ].join("");
    const text = invalid + bulkFrames(1_000, marker);
    const parses = countParses(ssePayloads(text));
    try {
      const iterator = bytesClient([enc.encode(text)])
        .events.stream()[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.id).toBe("evt_0");
      expect(parses.count()).toBe(4);
      await iterator.return?.();
    } finally {
      parses.restore();
    }
  });

  it("yields every event of a fully consumed large chunk in order, including the end-of-stream frame", async () => {
    const text = bulkFrames(10_000, "bulk-full") + `data: ${JSON.stringify({ ...clicked, id: "final" })}`;
    const ids = (await collect(bytesClient([enc.encode(text)]).events.stream())).map((r) => r.id);
    expect(ids).toHaveLength(10_001);
    expect(ids[0]).toBe("evt_0");
    expect(ids[9_999]).toBe("evt_9999");
    expect(ids[10_000]).toBe("final");
  });
});

describe("EventsResource.stream reads that settle just before an abort", () => {
  const marker = "fixture-after-abort";
  const fixtureText =
    Array.from({ length: 1_000 }, () => frame({ ts: opened.ts, note: marker })).join("") +
    bulkFrames(5, marker);

  it.each(["first chunk", "mid-stream chunk"] as const)(
    "neither decodes nor parses a %s, and keeps the abort reason",
    async (variant) => {
      const cancelled = enc.encode(fixtureText);
      const steps: Array<Uint8Array | "close"> =
        variant === "first chunk" ? [cancelled, "close"] : [enc.encode(frame(opened)), cancelled, "close"];
      const controller = new AbortController();
      const reason = new Error(`abort after ${variant} read`);
      const listeners = countAbortListeners(controller.signal);
      const source = settleThenAbortBody(steps, steps.indexOf(cancelled), () => controller.abort(reason));
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(source.body));
      const parses = countParses(ssePayloads(fixtureText));
      const decodes = trackDecodes();
      try {
        const iterator = clientWith(fetch).events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
        if (variant === "mid-stream chunk") {
          await expect(iterator.next()).resolves.toEqual({ done: false, value: opened });
        }
        await expectAborted(iterator.next(), reason);
        expect(parses.count(), "no fixture frame is parsed after the abort").toBe(0);
        expect(decodes.decoded(cancelled), "the settled chunk is not decoded").toBe(false);
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      } finally {
        parses.restore();
        decodes.restore();
      }
      expect(fetch.mock.calls[0]?.[1]?.signal?.reason).toBe(reason);
      expect(source.onCancel).toHaveBeenCalledTimes(1);
      expect(source.body.locked).toBe(false);
      expect(listeners()).toBe(0);
    },
  );

  it("delivers no final event when the end-of-stream read settles just before the abort", async () => {
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    // The compatibility frame has no closing blank line, so it is only parsed
    // once the end-of-stream read has been processed.
    const text = `data: ${JSON.stringify({ ...clicked, note: marker })}`;
    const source = settleThenAbortBody([enc.encode(text), "close"], 1, () =>
      controller.abort("abort after end-of-stream read"),
    );
    const parses = countParses(ssePayloads(text));
    try {
      await expectAborted(
        collect(clientWith(async () => new Response(source.body)).events.stream({ signal: controller.signal })),
        "abort after end-of-stream read",
      );
      expect(parses.count()).toBe(0);
    } finally {
      parses.restore();
    }
    expect(source.body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });

  it("skips JSON parsing when the abort lands after the error-text helper finishes, before its caller resumes", async () => {
    const errorText = JSON.stringify({ error: { code: marker, message: "fixture" } });
    const errorChunk = enc.encode(errorText);
    const controller = new AbortController();
    const reason = new Error("abort at the error-text handoff");
    const listeners = countAbortListeners(controller.signal);
    const steps: string[] = [];
    const body = errorBodyWithReleaseHook(errorChunk, () => {
      steps.push("helper released its reader");
      queueMicrotask(() => {
        steps.push("abort");
        controller.abort(reason);
      });
    });
    const parses = countParses([errorText]);
    const decodes = trackDecodes();
    try {
      await expectAborted(
        collect(
          clientWith(
            async () => new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
          ).events.stream({ signal: controller.signal }),
        ),
        reason,
      );
      // The helper finished: it decoded the whole body before the abort.
      expect(decodes.decoded(errorChunk)).toBe(true);
      expect(steps).toEqual(["helper released its reader", "abort"]);
      expect(parses.count(), "the error text is not JSON-parsed after the abort").toBe(0);
    } finally {
      parses.restore();
      decodes.restore();
    }
    expect(body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });

  it.each([
    ["chunk", 0],
    ["end-of-stream", 1],
  ] as const)(
    "neither decodes nor parses an error body whose %s read settles just before the abort",
    async (variant, abortAt) => {
      const errorText = JSON.stringify({ error: { code: marker, message: "fixture" } });
      const errorChunk = enc.encode(errorText);
      const controller = new AbortController();
      const listeners = countAbortListeners(controller.signal);
      const source = settleThenAbortBody([errorChunk, "close"], abortAt, () =>
        controller.abort("abort during error body"),
      );
      const parses = countParses([errorText]);
      const decodes = trackDecodes();
      try {
        await expectAborted(
          collect(
            clientWith(
              async () =>
                new Response(source.body, { status: 500, headers: { "content-type": "application/json" } }),
            ).events.stream({ signal: controller.signal }),
          ),
          "abort during error body",
        );
        expect(parses.count(), "the error body is not parsed").toBe(0);
        if (variant === "chunk") {
          expect(decodes.decoded(errorChunk), "the settled chunk is not decoded").toBe(false);
        }
      } finally {
        parses.restore();
        decodes.restore();
      }
      expect(source.body.locked).toBe(false);
      expect(listeners()).toBe(0);
    },
  );
});

describe("EventsResource.stream overlapping streams on one client", () => {
  const a1 = { ...opened, id: "a1" };
  const a2 = { ...opened, id: "a2" };
  const b1 = { ...clicked, id: "b1" };
  const b2 = { ...clicked, id: "b2" };
  const b3 = { ...clicked, id: "b3" };

  it("leaves a stream with its own signal receiving events to a normal finish when another is cancelled", async () => {
    const a = controlledBody();
    const b = controlledBody();
    const { client, transportSignals } = sharedClient({ a: a.body, b: b.body });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const listenersA = countAbortListeners(controllerA.signal);
    const listenersB = countAbortListeners(controllerB.signal);
    const streamA = client.events.stream({ event_type: "a", signal: controllerA.signal })[Symbol.asyncIterator]();
    const streamB = client.events.stream({ event_type: "b", signal: controllerB.signal })[Symbol.asyncIterator]();

    // Frames split and interleaved across both bodies: parser state is per stream.
    const frameA = frame(a1);
    const frameB = frame(b1);
    a.push(frameA.slice(0, 20));
    b.push(frameB.slice(0, 25));
    a.push(frameA.slice(20));
    b.push(frameB.slice(25));
    await expect(streamA.next()).resolves.toEqual({ done: false, value: a1 });
    await expect(streamB.next()).resolves.toEqual({ done: false, value: b1 });

    const pendingA = streamA.next();
    const pendingB = streamB.next();
    const reasonA = new Error("cancel stream A only");
    controllerA.abort(reasonA);
    await expectAborted(pendingA, reasonA);

    b.push(frame(b2));
    await expect(pendingB).resolves.toEqual({ done: false, value: b2 });
    b.push(frame(b3));
    b.close();
    await expect(streamB.next()).resolves.toEqual({ done: false, value: b3 });
    await expect(streamB.next()).resolves.toEqual({ done: true, value: undefined });

    expect(controllerB.signal.aborted).toBe(false);
    expect(transportSignals.a).not.toBe(transportSignals.b);
    expect(transportSignals.a?.reason).toBe(reasonA);
    expect(transportSignals.b?.aborted).toBe(false);
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    expect(b.onCancel).not.toHaveBeenCalled();
    expect(a.body.locked).toBe(false);
    expect(b.body.locked).toBe(false);
    expect(listenersA()).toBe(0);
    expect(listenersB()).toBe(0);
  });

  it("rejects both streams with the original reason when a shared signal aborts", async () => {
    const a = controlledBody();
    const b = controlledBody();
    const { client, transportSignals } = sharedClient({ a: a.body, b: b.body });
    const shared = new AbortController();
    const listeners = countAbortListeners(shared.signal);
    const streamA = client.events.stream({ event_type: "a", signal: shared.signal })[Symbol.asyncIterator]();
    const streamB = client.events.stream({ event_type: "b", signal: shared.signal })[Symbol.asyncIterator]();
    a.push(frame(a1));
    b.push(frame(b1) + frame(b2));
    await expect(streamA.next()).resolves.toEqual({ done: false, value: a1 });
    await expect(streamB.next()).resolves.toEqual({ done: false, value: b1 });
    expect(listeners()).toBe(2);

    // A is waiting on a read; B is paused, holding b1 with b2 already buffered.
    const pendingA = streamA.next();
    const reason = new Error("shared cancel");
    shared.abort(reason);
    expect(b.onCancel, "the paused stream's body is cancelled at once").toHaveBeenCalledTimes(1);
    await expectAborted(pendingA, reason);
    await expectAborted(streamB.next(), reason);

    await expect(streamA.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(streamB.next()).resolves.toEqual({ done: true, value: undefined });
    expect(transportSignals.a).not.toBe(transportSignals.b);
    expect(transportSignals.a?.reason).toBe(reason);
    expect(transportSignals.b?.reason).toBe(reason);
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    expect(a.body.locked).toBe(false);
    expect(b.body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });

  it.each(["break", "finish", "error"] as const)(
    "leaves a shared caller signal and the other stream untouched when one stream ends by %s",
    async (exit) => {
      const a = controlledBody();
      const b = controlledBody();
      const { client, transportSignals } = sharedClient({ a: a.body, b: b.body });
      const shared = new AbortController();
      const listeners = countAbortListeners(shared.signal);
      const streamB = client.events.stream({ event_type: "b", signal: shared.signal })[Symbol.asyncIterator]();
      b.push(frame(b1));
      await expect(streamB.next()).resolves.toEqual({ done: false, value: b1 });

      a.push(frame(a1) + frame(a2));
      if (exit === "finish") a.close();
      const dropped = new TypeError("stream A connection reset");
      const receivedA: EventRecord[] = [];
      let failure: unknown;
      try {
        for await (const record of client.events.stream({ event_type: "a", signal: shared.signal })) {
          receivedA.push(record);
          if (exit === "break") break;
          if (exit === "error" && record.id === "a2") a.error(dropped);
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(exit === "error" ? dropped : undefined);
      expect(receivedA).toEqual(exit === "break" ? [a1] : [a1, a2]);
      expect(shared.signal.aborted, "the caller's signal is never aborted by the SDK").toBe(false);
      expect(listeners(), "only stream B's listener remains").toBe(1);
      expect(transportSignals.a?.aborted, "only an early exit aborts A's own transport signal").toBe(
        exit !== "finish",
      );
      expect(transportSignals.b?.aborted).toBe(false);
      expect(a.onCancel).toHaveBeenCalledTimes(exit === "break" ? 1 : 0);
      expect(a.body.locked).toBe(false);

      b.push(frame(b2));
      await expect(streamB.next()).resolves.toEqual({ done: false, value: b2 });
      b.close();
      await expect(streamB.next()).resolves.toEqual({ done: true, value: undefined });
      expect(shared.signal.aborted).toBe(false);
      expect(transportSignals.b?.aborted).toBe(false);
      expect(b.onCancel).not.toHaveBeenCalled();
      expect(b.body.locked).toBe(false);
      expect(listeners()).toBe(0);
    },
  );
});

describe("EventsResource.stream decoding follows demand", () => {
  const W = DECODE_WINDOW_BYTES;

  it("decodes a large chunk one window at a time, only as far as the next event", async () => {
    const frames = Array.from({ length: 10_000 }, (_, i) =>
      frame({ ...opened, event_type: "decode-demand", id: `evt_${i}` }),
    );
    const chunk = enc.encode(frames.join(""));
    expect(chunk.byteLength, "the fixture spans many decode windows").toBeGreaterThanOrEqual(32 * W);
    const ends = frameEnds(frames);
    const source = nativeBody([chunk], { live: true });
    const decodes = trackDecodes();
    try {
      const iterator = clientWith(async () => new Response(source.body)).events.stream()[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) {
        expect((await iterator.next()).value?.id).toBe(`evt_${i}`);
        const decoded = decodes.decodedBytes(chunk);
        expect(decoded, `next() #${i + 1}: the bytes it needed were decoded`).toBeGreaterThanOrEqual(ends[i]!);
        expect(decoded, `next() #${i + 1}: at most one window beyond them`).toBeLessThanOrEqual(ends[i]! + W);
      }
      const decodedBeforeStop = decodes.decodedBytes(chunk);
      await iterator.return?.();
      await tick();
      expect(decodes.decodedBytes(chunk), "nothing is decoded after the consumer stops").toBe(decodedBeforeStop);
    } finally {
      decodes.restore();
    }
    expect(source.onCancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  });

  it("decodes frames larger than a window window by window, and no further when stopping early", async () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      frame({ ...opened, event_type: "decode-large", id: `big_${i}`, metadata: { pad: "é".repeat(40_000) } }),
    );
    const chunk = enc.encode(frames.join(""));
    const ends = frameEnds(frames);
    expect(ends[0], "each frame spans several windows").toBeGreaterThan(8 * W);
    const source = nativeBody([chunk], { live: true });
    const decodes = trackDecodes();
    try {
      const received: Array<string | undefined> = [];
      for await (const record of clientWith(async () => new Response(source.body)).events.stream()) {
        received.push(record.id);
        const i = received.length - 1;
        const decoded = decodes.decodedBytes(chunk);
        expect(decoded, `after event ${i + 1}`).toBeGreaterThanOrEqual(ends[i]!);
        expect(decoded, `after event ${i + 1}`).toBeLessThanOrEqual(ends[i]! + W);
        if (received.length === 2) break;
      }
      expect(received).toEqual(["big_0", "big_1"]);
      expect(decodes.decodedBytes(chunk)).toBeLessThanOrEqual(ends[1]! + W);
      expect(chunk.byteLength - decodes.decodedBytes(chunk), "most of the chunk is never decoded").toBeGreaterThan(
        16 * W,
      );
    } finally {
      decodes.restore();
    }
    expect(source.onCancel).toHaveBeenCalledTimes(1);
  });

  it("positive control with sliced buffers: decodes every byte of each view exactly once, nothing outside", async () => {
    const label = "café 🌊 中文";
    const frames = Array.from({ length: 2_000 }, (_, i) => frame({ ...clicked, id: `s_${i}`, metadata: { label } }));
    const expected = frames.map((_, i) => ({ ...clicked, id: `s_${i}`, metadata: { label } }));
    const bytes = enc.encode(frames.join(""));
    expect(bytes.byteLength).toBeGreaterThan(16 * W);
    const midChar = (from: number) => {
      let at = from;
      while (!isContinuationByte(bytes, at)) at++;
      return at;
    };
    const cuts = [0, midChar(W - 2), midChar(3 * W + 100), midChar(9 * W - 1), midChar(12 * W + 7), bytes.byteLength];
    const GUARD = 5;
    const backing = new Uint8Array(bytes.byteLength + GUARD * cuts.length).fill(0xff);
    const views: Uint8Array[] = [];
    const guards: Uint8Array[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const at = cuts[i]! + GUARD * (i + 1);
      backing.set(bytes.subarray(cuts[i]!, cuts[i + 1]!), at);
      views.push(backing.subarray(at, at + cuts[i + 1]! - cuts[i]!));
      guards.push(backing.subarray(at - GUARD, at));
    }
    const asDataView = new DataView(views[1]!.buffer, views[1]!.byteOffset, views[1]!.byteLength);
    const asArrayBuffer = views[3]!.slice().buffer;
    const source = nativeBody([views[0], asDataView, views[2], asArrayBuffer, views[4]]);
    const decodes = trackDecodes();
    try {
      await expect(collect(clientWith(async () => new Response(source.body)).events.stream())).resolves.toEqual(
        expected,
      );
      for (const [i, view] of views.entries()) {
        const measured = i === 3 ? new Uint8Array(asArrayBuffer) : view;
        expect(decodes.decodedBytes(measured), `slice ${i} decoded exactly once`).toBe(view.byteLength);
      }
      for (const [i, guard] of guards.entries()) {
        expect(decodes.decodedBytes(guard), `guard ${i} never decoded`).toBe(0);
      }
    } finally {
      decodes.restore();
    }
  });

  it("decodes characters and CRLF split by window or chunk boundaries as if contiguous", async () => {
    const expected: EventRecord[] = [];
    const straddled: number[] = [];
    let text = "";
    for (const char of ["é", "中", "🌊"]) {
      for (let shift = 1; shift < utf8Length(char); shift++) {
        const next = frameAcrossWindow(utf8Length(text), char, shift, `width${utf8Length(char)}-shift${shift}`);
        straddled.push(utf8Length(text) + utf8Length(next.slice(0, next.indexOf(char))) + shift);
        expected.push(JSON.parse(next.slice("data: ".length)) as EventRecord);
        text += next;
      }
    }
    const crlfRecord = { ...clicked, id: "crlf", metadata: { pad: "" } };
    const head = (pad: number) =>
      `data: ${JSON.stringify({ ...crlfRecord, metadata: { pad: "x".repeat(pad) } }).slice(0, -1)},`;
    const offset = utf8Length(text);
    const pad = Math.ceil((offset + utf8Length(head(0)) + 1) / W) * W - 1 - offset - utf8Length(head(0));
    text += `${head(pad)}\r\ndata: "tail":"ok"}\r\n\r\n`;
    straddled.push(offset + utf8Length(head(pad)) + 1);
    expected.push({ ...crlfRecord, metadata: { pad: "x".repeat(pad) }, tail: "ok" } as EventRecord);
    const eofRecord = { ...opened, id: "eof-compat", metadata: { label: "🌊".repeat(3_000) } };
    text += `data: ${JSON.stringify(eofRecord)}`;
    expected.push(eofRecord);
    const bytes = Uint8Array.of(...enc.encode(text));
    for (const at of straddled.slice(0, -1)) {
      expect(at % W, "fixture: a window boundary").toBe(0);
      expect(isContinuationByte(bytes, at), `fixture: window boundary ${at} is inside a character`).toBe(true);
    }
    expect(bytes[straddled.at(-1)! - 1]).toBe(0x0d);
    expect(bytes[straddled.at(-1)!]).toBe(0x0a);

    const splits = [
      [bytes],
      straddled
        .map((at, i) => bytes.slice(i === 0 ? 0 : straddled[i - 1]! - 1, at - 1))
        .concat([bytes.slice(straddled.at(-1)! - 1)]),
      chunked(bytes, 4093),
      chunked(bytes, W + 1),
    ];
    for (const [i, chunks] of splits.entries()) {
      expect(await collect(bytesClient(chunks).events.stream()), `delivery ${i}`).toEqual(expected);
    }
    const truncated = Uint8Array.of(...enc.encode(frame(opened)), 0xf0, 0x9f, 0x8c);
    await expect(collect(bytesClient([truncated]).events.stream())).resolves.toEqual([opened]);
  });

  it("decodes and parses nothing after an abort, and the instruments would have seen it (negative control)", async () => {
    const text = bulkFrames(10_000, "decode-abort");
    const chunk = enc.encode(text);
    const source = nativeBody([chunk], { live: true });
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const decodes = trackDecodes();
    const parses = countParses(ssePayloads(text));
    try {
      const iterator = clientWith(async () => new Response(source.body))
        .events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.id).toBe("evt_0");
      const decodedAtAbort = decodes.decodedBytes(chunk);
      const parsedAtAbort = parses.count();
      expect(decodedAtAbort, "positive control: the first event's decoding was seen").toBeGreaterThan(0);
      expect(decodedAtAbort).toBeLessThanOrEqual(W);
      controller.abort("abort with most of the chunk undecoded");
      expect(source.onCancel).toHaveBeenCalledTimes(1);
      await expectAborted(iterator.next(), "abort with most of the chunk undecoded");
      await tick();
      expect(decodes.decodedBytes(chunk), "no decoding after the abort").toBe(decodedAtAbort);
      expect(parses.count(), "no parsing after the abort").toBe(parsedAtAbort);
      // Negative control: the unwanted work these assertions rule out,
      // done deliberately, is measured by the same instruments.
      new TextDecoder().decode(chunk.subarray(decodedAtAbort, decodedAtAbort + W));
      expect(decodes.decodedBytes(chunk)).toBe(decodedAtAbort + W);
      JSON.parse(ssePayloads(text)[9_999]!);
      expect(parses.count()).toBe(parsedAtAbort + 1);
    } finally {
      decodes.restore();
      parses.restore();
    }
    expect(source.body.locked).toBe(false);
    expect(listeners()).toBe(0);
  });

  it("keeps separate decoder state and bounds for interleaved streams; aborting one stops only its decoding", async () => {
    const build = (prefix: string, char: string) =>
      Array.from({ length: 400 }, (_, i) =>
        frame({ ...opened, event_type: prefix, id: `${prefix}_${i}`, metadata: { text: char.repeat(300 + (i % 7)) } }),
      );
    const framesA = build("a", "🌊");
    const framesB = build("b", "中");
    const chunkA = enc.encode(framesA.join(""));
    const chunkB = enc.encode(framesB.join(""));
    const endsA = frameEnds(framesA);
    const endsB = frameEnds(framesB);
    for (const bytes of [chunkA, chunkB]) {
      expect(bytes.byteLength).toBeGreaterThan(32 * W);
      expect([1, 2, 3].some((k) => isContinuationByte(bytes, k * W)), "fixture: a boundary inside a character").toBe(
        true,
      );
    }
    const a = nativeBody([chunkA], { live: true });
    const b = nativeBody([chunkB]);
    const { client } = sharedClient({ a: a.body, b: b.body });
    const controllerA = new AbortController();
    const decodes = trackDecodes();
    try {
      const streamA = client.events.stream({ event_type: "a", signal: controllerA.signal })[Symbol.asyncIterator]();
      const streamB = client.events.stream({ event_type: "b" })[Symbol.asyncIterator]();
      for (let i = 0; i < 60; i++) {
        const fromA = await streamA.next();
        const fromB = await streamB.next();
        expect(fromA.value).toEqual(JSON.parse(framesA[i]!.slice("data: ".length)));
        expect(fromB.value).toEqual(JSON.parse(framesB[i]!.slice("data: ".length)));
        const decodedA = decodes.decodedBytes(chunkA);
        const decodedB = decodes.decodedBytes(chunkB);
        expect(decodedA).toBeGreaterThanOrEqual(endsA[i]!);
        expect(decodedA).toBeLessThanOrEqual(endsA[i]! + W);
        expect(decodedB).toBeGreaterThanOrEqual(endsB[i]!);
        expect(decodedB).toBeLessThanOrEqual(endsB[i]! + W);
      }
      const decodedAAtAbort = decodes.decodedBytes(chunkA);
      controllerA.abort("abort stream A");
      await expectAborted(streamA.next(), "abort stream A");
      const restB: EventRecord[] = [];
      for (let r = await streamB.next(); !r.done; r = await streamB.next()) restB.push(r.value);
      expect(restB).toHaveLength(400 - 60);
      expect(restB.at(-1)?.id).toBe("b_399");
      expect(decodes.decodedBytes(chunkA), "stream A decodes nothing after its abort").toBe(decodedAAtAbort);
      expect(decodes.decodedBytes(chunkB), "stream B decodes every byte exactly once").toBe(chunkB.byteLength);
    } finally {
      decodes.restore();
    }
    expect(a.onCancel).toHaveBeenCalledTimes(1);
    expect(b.onCancel).not.toHaveBeenCalled();
  });
});

describe("EventsResource.stream frame limit, Unicode and a leading BOM", () => {
  const LIMIT = 256 * 1024; // UTF-16 code units, not bytes
  const W = DECODE_WINDOW_BYTES;

  it("does not count a leading BOM, whole or fragmented, toward the first frame, and still skips an oversized frame", async () => {
    const atLimit = lineOfUnits(LIMIT, "x", "at-limit");
    const phantomLine = `data: ${JSON.stringify({ ...opened, event_type: "phantom" })}`;
    const oversized = `data: ${"y".repeat(LIMIT + 1 - 1 - phantomLine.length - "data: ".length)}\n${phantomLine}`;
    expect(atLimit.line.length, "fixture: first frame exactly at the limit").toBe(LIMIT);
    expect(oversized.length, "fixture: second frame one unit over").toBe(LIMIT + 1);
    const bytes = concatBytes(UTF8_BOM, enc.encode(`${atLimit.line}\n\n${oversized}\n\n${frame(clicked)}`));
    const head = Array.from({ length: 12 }, (_, i) => bytes.subarray(i, i + 1));
    const deliveries: Array<[string, Uint8Array[]]> = [
      ["one chunk", [bytes]],
      [
        "BOM byte by byte after an empty chunk",
        [new Uint8Array(0), bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2, 3), bytes.subarray(3)],
      ],
      ["first 12 bytes one at a time, then 4093-byte chunks", [...head, ...chunked(bytes.subarray(12), 4093)]],
      ["window-plus-one chunks", chunked(bytes, W + 1)],
    ];
    for (const [label, chunks] of deliveries) {
      expect(await collect(bytesClient(chunks).events.stream()), label).toEqual([atLimit.record, clicked]);
    }
    // Only one leading BOM is ignored, as before: a second U+FEFF is content,
    // so the first line's field is not `data` and that frame yields nothing.
    const doubled = concatBytes(UTF8_BOM, UTF8_BOM, enc.encode(frame(opened) + frame(clicked)));
    await expect(collect(bytesClient([doubled]).events.stream())).resolves.toEqual([clicked]);
    await expect(collect(bytesClient(chunked(doubled, 1)).events.stream())).resolves.toEqual([clicked]);
  });

  it("treats a U+FEFF after an oversized frame as content, not a BOM: only the tail event is emitted", async () => {
    const afterBom = { ...opened, event_type: "after-bom" };
    const tail = { ...clicked, event_type: "tail" };
    // The U+FEFF right after the oversized frame, then placed to start a
    // decode window, then to straddle one (ASCII: units equal bytes).
    for (const bomAt of [undefined, 33 * W, 33 * W - 1]) {
      const oversizedUnits = bomAt === undefined ? LIMIT + 1 : bomAt - 2;
      const oversized = `data: ${"x".repeat(oversizedUnits - "data: ".length)}`;
      const bytes = enc.encode(`${oversized}\n\n\uFEFFdata: ${JSON.stringify(afterBom)}\n\n${frame(tail)}`);
      const at = utf8Length(`${oversized}\n\n`);
      const label =
        bomAt === undefined ? "U+FEFF after the frame" : bomAt % W === 0 ? "U+FEFF starts a window" : "U+FEFF straddles a window";
      expect(oversized.length, `fixture (${label}): the first frame is oversized`).toBeGreaterThan(LIMIT);
      expect([...bytes.subarray(at, at + 3)], `fixture (${label}): U+FEFF bytes`).toEqual([0xef, 0xbb, 0xbf]);
      if (bomAt !== undefined) expect(at, `fixture (${label}): U+FEFF position`).toBe(bomAt);
      const deliveries: Array<[string, Uint8Array[]]> = [
        ["one chunk", [bytes]],
        ["a chunk starts at U+FEFF", [bytes.subarray(0, at), bytes.subarray(at)]],
        ["U+FEFF split 1|2", [bytes.subarray(0, at + 1), bytes.subarray(at + 1)]],
        ["U+FEFF split 2|1", [bytes.subarray(0, at + 2), bytes.subarray(at + 2)]],
        [
          "byte by byte around U+FEFF",
          [
            bytes.subarray(0, at - 4),
            ...Array.from({ length: 16 }, (_, i) => bytes.subarray(at - 4 + i, at - 3 + i)),
            bytes.subarray(at + 12),
          ],
        ],
        ["window-plus-one chunks", chunked(bytes, W + 1)],
      ];
      for (const [how, chunks] of deliveries) {
        expect(await collect(bytesClient(chunks).events.stream()), `${label}, ${how}`).toEqual([tail]);
      }
    }
  });

  it("counts the frame limit in UTF-16 code units, not UTF-8 bytes", async () => {
    const expected: EventRecord[] = [];
    let text = "";
    for (const char of ["é", "中", "🌊"]) {
      const atLimit = lineOfUnits(LIMIT, char, `at-limit ${char}`);
      const overLimit = lineOfUnits(LIMIT + 1, char, `over-limit ${char}`);
      expect(utf8Length(atLimit.line), `fixture: ${char} frame at the limit is far over ${LIMIT} bytes`).toBeGreaterThan(
        LIMIT * 1.9,
      );
      text += `${atLimit.line}\n\n${overLimit.line}\n\n`;
      expected.push(atLimit.record);
    }
    text += frame(clicked);
    expected.push(clicked);
    const bytes = enc.encode(text);
    for (const [label, chunks] of [
      ["one chunk", [bytes]],
      ["window-plus-one chunks", chunked(bytes, W + 1)],
      ["4093-byte chunks", chunked(bytes, 4093)],
    ] as const) {
      expect(await collect(bytesClient([...chunks]).events.stream()), label).toEqual(expected);
    }
  });

  it("keeps a frame whose surrogate pair completes exactly at the limit and drops one that crosses it", async () => {
    const dataLine = `data: ${JSON.stringify({ ...opened, id: "surrogate" })}`;
    // frame = data line + "\n" + comment line ending in U+1F30A (two units).
    const frameOf = (units: number) =>
      `${dataLine}\n: ${"z".repeat(units - dataLine.length - 1 - ": ".length - 2)}🌊`;
    const kept = frameOf(LIMIT);
    const dropped = frameOf(LIMIT + 1);
    expect(kept.length).toBe(LIMIT);
    expect(dropped.length).toBe(LIMIT + 1);
    for (const [label, text, expected] of [
      ["completes at the limit", kept, [{ ...opened, id: "surrogate" }, clicked]],
      ["crosses the limit", dropped, [clicked]],
    ] as const) {
      const bytes = enc.encode(`${text}\n\n${frame(clicked)}`);
      const emojiEnd = utf8Length(text);
      const deliveries = [[bytes], [bytes.subarray(0, emojiEnd - 2), bytes.subarray(emojiEnd - 2)], chunked(bytes, W + 1)];
      for (const [i, chunks] of deliveries.entries()) {
        expect(await collect(bytesClient(chunks).events.stream()), `${label}, delivery ${i}`).toEqual(expected);
      }
    }
  });
});

