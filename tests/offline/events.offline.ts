// SPDX-License-Identifier: MIT
/**
 * Event-stream regressions using only Node's built-in test runner.
 * Run npm run --offline test:events:offline without installing dependencies.
 *
 * Covers the compatibility baseline plus the stream-hardening regressions:
 * chunk-boundary independence, oversized/malformed frame recovery,
 * cancellation and cleanup with transports and bodies that ignore their
 * signal (including the windows before the body is read, after the final
 * event, after a read that settled just before the abort, and at the HTTP
 * error-text hand-off), demand-driven parsing and UTF-8 decoding, and
 * overlapping streams on one client. Parse and decode work is asserted by
 * counting parses and decoded bytes, with positive and negative controls. It does not prove complete SSE conformance (only `data` is used,
 * and there is no reconnection). The full vitest suite is
 * tests/events-stream.test.ts, run by `npm run verify`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  NotFoundError,
  PostwaveClient,
  RequestAbortedError,
  ServerError,
} from "../../src/index.js";
import { DECODE_WINDOW_BYTES, type EventRecord } from "../../src/resources/events.js";
import { syntheticCredential } from "../fixture-data.js";

const encoder = new TextEncoder();
const opened = { ts: "2026-05-19T00:00:00Z", event_type: "opened" };
const clicked = { ts: "2026-05-19T01:00:00Z", event_type: "clicked" };
const frame = (record: unknown) => `data: ${JSON.stringify(record)}\n\n`;

function response(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" }, ...init });
}

async function collect(iterable: AsyncIterable<EventRecord>): Promise<EventRecord[]> {
  const records: EventRecord[] = [];
  for await (const record of iterable) records.push(record);
  return records;
}

function clientFor(chunks: string[]): PostwaveClient {
  return new PostwaveClient({
    authMode: "none",
    fetch: async () => response(chunks.map((chunk) => encoder.encode(chunk))),
  });
}

function bytesClient(chunks: Uint8Array[]): PostwaveClient {
  return new PostwaveClient({ authMode: "none", fetch: async () => response(chunks) });
}

/** Split `bytes` into chunks of `size` bytes. */
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
  assert.equal(line.length, chars);
  return { line, record };
}

/**
 * A body that delivers `first` (if any) and then stalls forever, ignoring
 * every signal. Counts cancellations so cleanup can be asserted.
 */
function stalledBody(first?: string, cancel?: () => Promise<void>) {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first !== undefined) controller.enqueue(encoder.encode(first));
    },
    cancel() {
      cancellations++;
      return cancel?.();
    },
  });
  return { body, cancellations: () => cancellations };
}

/** Count "abort" listeners still attached to `signal` (no vitest available here). */
function countAbortListeners(signal: AbortSignal): () => number {
  type ListenerFn = (type: string, listener: unknown, options?: unknown) => void;
  const live = new Set<unknown>();
  const target = signal as unknown as { addEventListener: ListenerFn; removeEventListener: ListenerFn };
  const add = target.addEventListener.bind(signal);
  const remove = target.removeEventListener.bind(signal);
  target.addEventListener = (type, listener, options) => {
    if (type === "abort" && listener) live.add(listener);
    add(type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    if (type === "abort") live.delete(listener);
    remove(type, listener, options);
  };
  return () => live.size;
}

/** Settle `promise` or fail after `ms`, so a hang is a failure, not a stuck run. */
async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Observable parse work: counts JSON.parse calls whose input is exactly one
 * of `payloads`. The SDK parses each SSE frame's joined `data` value, or an
 * HTTP error body's text, once; so this counts how many fixture frames (or
 * error bodies) the stream has parsed. Exact matching matters: counting any
 * text that merely contains a fixture marker also counts unrelated parses,
 * such as a runner parsing a source map that embeds this file's source.
 * Always call restore() in `finally`.
 */
function countParses(payloads: Iterable<string>): { count: () => number; restore: () => void } {
  const expected = new Set(payloads);
  const realParse = JSON.parse;
  let count = 0;
  JSON.parse = function countingParse(text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    if (typeof text === "string" && expected.has(text)) count++;
    return realParse(text, reviver);
  } as typeof JSON.parse;
  return { count: () => count, restore: () => { JSON.parse = realParse; } };
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
 * Always call restore() in `finally`.
 */
function trackDecodes(): {
  decodedBytes: (chunk: Uint8Array) => number;
  decoded: (chunk: Uint8Array) => boolean;
  restore: () => void;
} {
  const realDecode = TextDecoder.prototype.decode;
  const ranges: Array<{ buffer: ArrayBufferLike; start: number; end: number }> = [];
  TextDecoder.prototype.decode = function trackingDecode(this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
    const range = byteRange(input);
    if (range) ranges.push(range);
    return realDecode.call(this, input, options);
  };
  const decodedBytes = (chunk: Uint8Array): number => {
    const start = chunk.byteOffset;
    const end = chunk.byteOffset + chunk.byteLength;
    let total = 0;
    for (const range of ranges) {
      if (range.buffer === chunk.buffer) total += Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
    }
    return total;
  };
  return {
    decodedBytes,
    decoded: (chunk) => decodedBytes(chunk) > 0,
    restore: () => { TextDecoder.prototype.decode = realDecode; },
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
  let cancellations = 0;
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
    cancel() { cancellations++; },
  });
  return { body, cancellations: () => cancellations };
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
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { cancellations++; },
  });
  return {
    body,
    push: (text: string) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
    error: (reason: unknown) => controller?.error(reason),
    cancellations: () => cancellations,
  };
}

/**
 * One client for overlapping streams. Its transport hands each stream the
 * body registered for its `event_type` filter and records the signal the
 * SDK gave that request.
 */
function sharedClient(bodies: Record<string, ReadableStream<Uint8Array>>) {
  const transportSignals: Record<string, AbortSignal | undefined> = {};
  const client = new PostwaveClient({
    authMode: "none",
    fetch: async (url, init) => {
      const key = new URL(url).searchParams.get("event_type") ?? "";
      const body = bodies[key];
      assert.ok(body, `no fixture body for ${key}`);
      transportSignals[key] = init?.signal ?? undefined;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { client, transportSignals };
}

const utf8Length = (text: string): number => encoder.encode(text).byteLength;

/** Byte offset at which each of `frames` ends, laid end to end. */
function frameEnds(frames: string[]): number[] {
  let end = 0;
  return frames.map((text) => (end += utf8Length(text)));
}

/** Whether the byte at `offset` continues a multi-byte UTF-8 character. */
const isContinuationByte = (bytes: Uint8Array, offset: number): boolean => ((bytes[offset] ?? 0) & 0xc0) === 0x80;

/**
 * A frame whose `text` run of `char` starts `shift` bytes before the next
 * decode-window boundary after `offset` (the frame's position in the
 * stream), so that boundary falls inside the first `char` when `shift` is
 * less than its byte length.
 */
function frameAcrossWindow(offset: number, char: string, shift: number, id: string): string {
  const build = (pad: number) => frame({ ...opened, event_type: "utf8", id, metadata: { pad: "x".repeat(pad), text: char.repeat(4) } });
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
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as Uint8Array);
      if (!live) controller.close();
    },
    cancel() { cancellations++; },
  });
  return { body, cancellations: () => cancellations };
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

function isAbortedWith(reason: unknown) {
  return (error: unknown) => {
    assert.ok(error instanceof RequestAbortedError, `expected RequestAbortedError, got ${String(error)}`);
    assert.equal(error.code, "request_aborted");
    assert.equal(error.payload, reason);
    return true;
  };
}

describe("offline: event stream compatibility", { concurrency: 1 }, () => {
  test("iteration uses the configured transport, filters and auth headers", async () => {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const apiKey = syntheticCredential("event-stream-header");
    const client = new PostwaveClient({
      apiKey,
      tenantId: "tenant-fixture",
      credentials: "include",
      defaultHeaders: { "X-Postwave-Client": "fixture" },
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response([encoder.encode(frame(opened))]);
      },
    });
    const events = client.events.stream({ event_type: "opened", campaign: "campaign-fixture" });
    assert.equal(calls.length, 0);
    assert.deepEqual(await collect(events), [opened]);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    const url = new URL(String(call.input));
    assert.equal(url.pathname, "/api/v1/events/stream");
    assert.equal(url.searchParams.get("event_type"), "opened");
    assert.equal(url.searchParams.get("campaign"), "campaign-fixture");
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("Accept"), "text/event-stream");
    assert.equal(headers.get("Authorization"), `Bearer ${apiKey}`);
    assert.equal(headers.get("X-Tenant-Slug"), "tenant-fixture");
    assert.equal(headers.get("X-Postwave-Client"), "fixture");
    assert.equal(call.init?.credentials, "include");
  });

  test("joins LF data lines and ignores comments and unknown fields", async () => {
    const client = clientFor([
      ': heartbeat\nevent: opened\nignored: fixture\ndata: {"ts":"2026-05-19T00:00:00Z",\n',
      'data: "event_type":"opened"}\n\n',
    ]);
    assert.deepEqual(await collect(client.events.stream()), [opened]);
  });

  test("accepts complete CRLF-delimited frames", async () => {
    const client = clientFor([frame(opened).replaceAll("\n", "\r\n")]);
    assert.deepEqual(await collect(client.events.stream()), [opened]);
  });

  test("keeps the existing complete-JSON-at-EOF compatibility behavior", async () => {
    const client = clientFor([`data: ${JSON.stringify(clicked)}\n`]);
    assert.deepEqual(await collect(client.events.stream()), [clicked]);
  });

  test("skips malformed, shape-invalid and complete oversized frames", async () => {
    const client = clientFor([
      "data: not-json\n\n",
      frame({ ts: opened.ts }),
      frame({ ...opened, metadata: [] }),
      frame({ ...opened, metadata: { blob: "x".repeat(300_000) } }),
      frame(clicked),
    ]);
    assert.deepEqual(await collect(client.events.stream()), [clicked]);
  });

  test("decodes UTF-8 when multibyte code points span transport chunks", async () => {
    const record = { ...opened, metadata: { label: "café 🌊" } };
    const bytes = encoder.encode(frame(record));
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async () => response(Array.from(bytes, (byte) => Uint8Array.of(byte))),
    });
    assert.deepEqual(await collect(client.events.stream()), [record]);
  });

  test("maps HTTP error status, code and request ID", async () => {
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async () => response([
        encoder.encode(JSON.stringify({ error: { code: "missing_stream", message: "fixture missing" } })),
      ], { status: 404, headers: { "content-type": "application/json", "x-request-id": "request-fixture" } }),
    });
    await assert.rejects(collect(client.events.stream()), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "missing_stream");
      assert.equal(error.requestId, "request-fixture");
      return true;
    });
  });

  test("breaking after an event cancels the open body and releases its lock", async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(frame(opened) + frame(clicked))); },
      cancel() { cancellations++; },
    });
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    let received = 0;
    for await (const record of client.events.stream()) {
      assert.deepEqual(record, opened);
      received++;
      break;
    }
    assert.equal(received, 1);
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  });
});

describe("offline: event stream parsing across chunk boundaries", { concurrency: 1 }, () => {
  test("a CRLF multi-line frame split between CR and LF is still delivered", async () => {
    const text = 'data: {"ts":"2026-05-19T00:00:00Z",\r\ndata: "event_type":"opened"}\r\n\r\n';
    const cr = text.indexOf("\r\n") + 1;
    assert.deepEqual(await collect(clientFor([text.slice(0, cr), text.slice(cr)]).events.stream()), [opened]);
  });

  test("every split point and chunk size yields the single-chunk result", async () => {
    const unicode = { ...clicked, metadata: { label: "café 🌊" } };
    const text = [
      ": heartbeat\r\n",
      'event: opened\r\ndata: {"ts":"2026-05-19T00:00:00Z",\r\ndata: "event_type":"opened"}\r\n\r\n',
      "data: not-json\n\n",
      `data: ${JSON.stringify(unicode)}\r\r`,
      'id: 7\ndata: {"ts":"2026-05-19T00:00:00Z",\n: inline comment\ndata:\t"event_type":"opened"}\n\n',
      `data: ${JSON.stringify(clicked)}\n`,
    ].join("");
    const bytes = encoder.encode(text);
    const expected = [opened, unicode, opened, clicked];
    assert.deepEqual(await collect(bytesClient([bytes]).events.stream()), expected);
    for (let at = 1; at < bytes.length; at++) {
      const got = await collect(bytesClient([bytes.slice(0, at), bytes.slice(at)]).events.stream());
      assert.deepEqual(got, expected, `split at byte ${at}`);
    }
    for (const size of [1, 2, 3, 5, 7, 16]) {
      const got = await collect(bytesClient(chunked(bytes, size)).events.stream());
      assert.deepEqual(got, expected, `${size}-byte chunks`);
    }
  });

  test("a frame exactly at the 262,144-code-unit limit is kept, one unit over is dropped, however it is split", async () => {
    const limit = 256 * 1024;
    const atLimit = frameOfLength(limit, "at-limit");
    const overLimit = frameOfLength(limit + 1, "over-limit");
    const bytes = encoder.encode(`${atLimit.line}\n\n${overLimit.line}\n\n${frame(clicked)}`);
    const expected = [atLimit.record, clicked];
    const terminator = atLimit.line.length + 1; // just after the first "\n" of the blank line
    for (const chunks of [
      [bytes],
      [bytes.slice(0, terminator), bytes.slice(terminator)],
      chunked(bytes, 4096),
      chunked(bytes, 4093),
    ]) {
      assert.deepEqual(await collect(bytesClient(chunks).events.stream()), expected);
    }
  });

  test("lines of an oversized frame are never parsed as frames of their own", async () => {
    const phantom = { ...opened, event_type: "phantom" };
    const bytes = encoder.encode(
      `data: ${"x".repeat(300_000)}\ndata: ${JSON.stringify(phantom)}\n\n${frame(clicked)}`,
    );
    for (const size of [bytes.length, 65_536, 4096, 1000]) {
      assert.deepEqual(await collect(bytesClient(chunked(bytes, size)).events.stream()), [clicked], `${size}-byte chunks`);
    }
  });

  test("recovers after an unterminated oversized line and drops one still open at EOF", async () => {
    const huge = encoder.encode(`: ${"y".repeat(600_000)}`);
    const recovered = [...chunked(huge, 8192), encoder.encode(`\n\n${frame(opened)}`)];
    assert.deepEqual(await collect(bytesClient(recovered).events.stream()), [opened]);

    const openAtEof = [encoder.encode(frame(opened)), ...chunked(encoder.encode(`data: ${"z".repeat(300_000)}\ndata: ${JSON.stringify(clicked)}`), 8192)];
    assert.deepEqual(await collect(bytesClient(openAtEof).events.stream()), [opened]);
  });

  test("recovers from invalid UTF-8, field-less garbage and truncated JSON at the next frame", async () => {
    const chunks = [
      Uint8Array.of(0xff, 0xfe, 0x0a, 0x0a),
      encoder.encode("garbage without a colon\n\u0000\u0001\n\n"),
      encoder.encode('data: {"ts":"2026-05-19T00:00:00Z","event_type":\n\n'),
      Uint8Array.of(...encoder.encode("data: "), 0xc3),
      encoder.encode("\n\n" + frame(opened)),
    ];
    assert.deepEqual(await collect(bytesClient(chunks).events.stream()), [opened]);
  });
});

describe("offline: event stream cancellation and cleanup", { concurrency: 1 }, () => {
  test("an already-aborted signal rejects without calling the transport", async () => {
    let calls = 0;
    const controller = new AbortController();
    const reason = new Error("fixture: stop before start");
    controller.abort(reason);
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async () => {
        calls++;
        return response([encoder.encode(frame(opened))]);
      },
    });
    await assert.rejects(collect(client.events.stream({ signal: controller.signal })), isAbortedWith(reason));
    assert.equal(calls, 0);
  });

  test("abort while connecting to a transport that ignores its signal, and a late body is cancelled", async () => {
    let resolveFetch: ((resp: Response) => void) | undefined;
    let transportSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({
      authMode: "none",
      fetch: (_url, init) => {
        transportSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveFetch = resolve; });
      },
    });
    const pending = collect(client.events.stream({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reason = new Error("fixture: stop while connecting");
    controller.abort(reason);
    await within(1000, assert.rejects(pending, isAbortedWith(reason)), "abort while connecting");
    assert.equal(transportSignal?.aborted, true);
    assert.equal(transportSignal?.reason, reason);
    assert.equal(listeners(), 0);

    const late = stalledBody(frame(opened));
    resolveFetch?.(new Response(late.body));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(late.cancellations(), 1);
  });

  test("abort during a stalled read of a body that ignores the signal", async () => {
    const stalled = stalledBody(frame(opened));
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(stalled.body) });
    const iterator = client.events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, opened);
    const next = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort("fixture: stop while reading");
    await within(1000, assert.rejects(next, isAbortedWith("fixture: stop while reading")), "abort while reading");
    assert.equal(stalled.cancellations(), 1);
    assert.equal(stalled.body.locked, false);
    assert.equal(listeners(), 0);
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });

  test("abort while the consumer holds an event releases the body at once and yields nothing more", async () => {
    const stalled = stalledBody(frame(opened) + frame(clicked));
    const controller = new AbortController();
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(stalled.body) });
    const iterator = client.events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, opened);
    controller.abort("fixture: stop between events");
    // Released before the consumer resumes, or even if it never does.
    assert.equal(stalled.cancellations(), 1);
    assert.equal(stalled.body.locked, false);
    // `clicked` was already parsed from the same chunk, but is not delivered.
    await assert.rejects(iterator.next(), isAbortedWith("fixture: stop between events"));
  });

  test("break returns promptly even when the body's cancel() never settles", async () => {
    const stalled = stalledBody(frame(opened), () => new Promise<void>(() => {}));
    let transportSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async (_url, init) => {
        transportSignal = init?.signal ?? undefined;
        return new Response(stalled.body);
      },
    });
    const consume = (async () => {
      for await (const record of client.events.stream({ signal: controller.signal })) {
        assert.deepEqual(record, opened);
        break;
      }
    })();
    await within(1000, consume, "break with a hanging cancel()");
    assert.equal(stalled.cancellations(), 1);
    assert.equal(stalled.body.locked, false);
    assert.equal(transportSignal?.aborted, true, "the transport is told the stream ended early");
    assert.equal(controller.signal.aborted, false, "the caller's own signal is untouched");
    assert.equal(listeners(), 0);
  });

  test("a stream that ends normally leaves no listener and does not abort the transport", async () => {
    let transportSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async (_url, init) => {
        transportSignal = init?.signal ?? undefined;
        return response([encoder.encode(frame(opened))]);
      },
    });
    assert.deepEqual(await collect(client.events.stream({ signal: controller.signal })), [opened]);
    assert.equal(listeners(), 0);
    assert.equal(transportSignal?.aborted, false);
  });

  test("a dropped connection surfaces the transport's error unchanged and releases the reader", async () => {
    const dropped = new TypeError("fixture: connection reset");
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(frame(opened)));
        else controller.error(dropped);
      },
    });
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(body) });
    const received: EventRecord[] = [];
    await assert.rejects(
      (async () => {
        for await (const record of client.events.stream({ signal: controller.signal })) received.push(record);
      })(),
      (error: unknown) => error === dropped,
    );
    assert.deepEqual(received, [opened]);
    assert.equal(body.locked, false);
    assert.equal(listeners(), 0);
  });
});

describe("offline: event stream error-response cleanup", { concurrency: 1 }, () => {
  test("an error body that fails mid-read still maps the status and unlocks the body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("fixture: body failed")); },
    });
    const client = new PostwaveClient({
      authMode: "none",
      retries: 0,
      fetch: async () => new Response(body, { status: 500, headers: { "x-request-id": "request-fixture" } }),
    });
    await assert.rejects(collect(client.events.stream()), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.requestId, "request-fixture");
      return true;
    });
    assert.equal(body.locked, false);
  });

  test("an error body over 64 KiB is cancelled and unlocked, by streamed size or content-length", async () => {
    let cancellations = 0;
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(70_000)); },
      cancel() { cancellations++; },
    });
    const declared = stalledBody("{}");
    for (const resp of [
      new Response(streamed, { status: 500 }),
      new Response(declared.body, { status: 502, headers: { "content-length": "999999" } }),
    ]) {
      const client = new PostwaveClient({ authMode: "none", retries: 0, fetch: async () => resp });
      await within(1000, assert.rejects(collect(client.events.stream()), ServerError), `HTTP ${resp.status}`);
    }
    assert.equal(cancellations, 1);
    assert.equal(streamed.locked, false);
    assert.equal(declared.cancellations(), 1, "an oversized declared body is never read");
    assert.equal(declared.body.locked, false);
  });

  test("abort during a stalled error-body read rejects and cancels the body", async () => {
    const stalled = stalledBody('{"error":');
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({
      authMode: "none",
      fetch: async () => new Response(stalled.body, { status: 503, headers: { "content-type": "application/json" } }),
    });
    const pending = collect(client.events.stream({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort("fixture: stop during error body");
    await within(1000, assert.rejects(pending, isAbortedWith("fixture: stop during error body")), "abort during error body");
    assert.equal(stalled.cancellations(), 1);
    assert.equal(stalled.body.locked, false);
    assert.equal(listeners(), 0);
  });
});

describe("offline: event stream abort windows", { concurrency: 1 }, () => {
  for (const status of [200, 500]) {
    test(`an abort after the transport resolves but before the body is read cancels it (HTTP ${status})`, async () => {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(frame(opened))); },
        cancel() { cancellations++; },
      });
      const controller = new AbortController();
      const listeners = countAbortListeners(controller.signal);
      const client = new PostwaveClient({
        authMode: "none",
        retries: 0,
        // Resolve, then abort one microtask later: after the SDK has the
        // response, before its continuation attaches a reader or reads.
        fetch: () => new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(new Response(body, { status }));
            queueMicrotask(() => controller.abort("fixture: abort before reader"));
          }, 0);
        }),
      });
      await within(1000, assert.rejects(collect(client.events.stream({ signal: controller.signal })), isAbortedWith("fixture: abort before reader")), "abort before reader");
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
      assert.equal(listeners(), 0);
    });
  }

  test("an abort after the final end-of-stream event rejects the next next()", async () => {
    for (const text of [`data: ${JSON.stringify(clicked)}`, frame(clicked)]) {
      const controller = new AbortController();
      const listeners = countAbortListeners(controller.signal);
      const iterator = clientFor([text]).events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      assert.deepEqual(await iterator.next(), { done: false, value: clicked });
      controller.abort("fixture: abort after last event");
      await assert.rejects(iterator.next(), isAbortedWith("fixture: abort after last event"));
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
      assert.equal(listeners(), 0);
    }
  });

  test("break after an abort in the loop body ends quietly and releases the body", async () => {
    const stalled = stalledBody(frame(opened) + frame(clicked));
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(stalled.body) });
    const received: EventRecord[] = [];
    for await (const record of client.events.stream({ signal: controller.signal })) {
      received.push(record);
      controller.abort("fixture: abort then break");
      break;
    }
    assert.deepEqual(received, [opened]);
    assert.equal(stalled.cancellations(), 1);
    assert.equal(stalled.body.locked, false);
    assert.equal(listeners(), 0);
  });

  test("without an abort, the final end-of-stream event still completes normally", async () => {
    const controller = new AbortController();
    const iterator = clientFor([`data: ${JSON.stringify(clicked)}`]).events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { done: false, value: clicked });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    controller.abort("fixture: abort after completion");
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });
});

describe("offline: event stream demand-driven parsing", { concurrency: 1 }, () => {
  test("a 10,000-event chunk is parsed one frame per next(), and not past a break", async () => {
    const text = bulkFrames(10_000, "bulk-demand");
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(text)); },
      cancel() { cancellations++; },
    });
    const parses = countParses(ssePayloads(text));
    try {
      const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(body) });
      const iterator = client.events.stream()[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) {
        const { value } = await iterator.next();
        assert.equal(value?.id, `evt_${i}`);
        assert.equal(parses.count(), i + 1, `frames parsed after next() #${i + 1}`);
      }
      await iterator.return?.();
      assert.equal(parses.count(), 3, "nothing is parsed after the consumer stops");
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
    } finally {
      parses.restore();
    }
  });

  test("an abort part-way through a large chunk stops parsing there", async () => {
    const text = bulkFrames(10_000, "bulk-abort");
    const controller = new AbortController();
    const parses = countParses(ssePayloads(text));
    try {
      const client = clientFor([text]);
      const iterator = client.events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.id, "evt_0");
      controller.abort("fixture: abort mid-chunk");
      await assert.rejects(iterator.next(), isAbortedWith("fixture: abort mid-chunk"));
      assert.equal(parses.count(), 1);
    } finally {
      parses.restore();
    }
  });

  test("frames that yield no record are skipped within the same next(), and no further", async () => {
    const marker = "bulk-skip";
    const invalid = [
      `data: {"${marker}":\n\n`,
      frame({ ts: opened.ts, note: marker }),
      frame({ ...opened, event_type: marker, metadata: [] }),
    ].join("");
    const text = invalid + bulkFrames(1_000, marker);
    const parses = countParses(ssePayloads(text));
    try {
      const iterator = clientFor([text]).events.stream()[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.id, "evt_0");
      assert.equal(parses.count(), 4, "three skipped frames and one delivered");
      await iterator.return?.();
    } finally {
      parses.restore();
    }
  });

  test("consuming a large chunk fully still yields every event in order, including the end-of-stream frame", async () => {
    const marker = "bulk-full";
    const text = bulkFrames(10_000, marker) + `data: ${JSON.stringify({ ...clicked, id: "final" })}`;
    const ids: Array<string | undefined> = [];
    for await (const record of clientFor([text]).events.stream()) ids.push(record.id);
    assert.equal(ids.length, 10_001);
    assert.equal(ids[0], "evt_0");
    assert.equal(ids[9_999], "evt_9999");
    assert.equal(ids[10_000], "final");
  });
});

describe("offline: event stream reads that settle just before an abort", { concurrency: 1 }, () => {
  const marker = "fixture-after-abort";
  const fixtureText =
    Array.from({ length: 1_000 }, () => frame({ ts: opened.ts, note: marker })).join("") + bulkFrames(5, marker);

  for (const variant of ["first chunk", "mid-stream chunk"] as const) {
    test(`a ${variant} is neither decoded nor parsed, and the abort reason is kept`, async () => {
      const cancelled = encoder.encode(fixtureText);
      const steps: Array<Uint8Array | "close"> = variant === "first chunk"
        ? [cancelled, "close"]
        : [encoder.encode(frame(opened)), cancelled, "close"];
      const controller = new AbortController();
      const reason = new Error(`fixture: abort after ${variant} read`);
      const listeners = countAbortListeners(controller.signal);
      const source = settleThenAbortBody(steps, steps.indexOf(cancelled), () => controller.abort(reason));
      let transportSignal: AbortSignal | undefined;
      const client = new PostwaveClient({
        authMode: "none",
        fetch: async (_url, init) => {
          transportSignal = init?.signal ?? undefined;
          return new Response(source.body);
        },
      });
      const parses = countParses(ssePayloads(fixtureText));
      const decodes = trackDecodes();
      try {
        const iterator = client.events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
        if (variant === "mid-stream chunk") {
          assert.deepEqual(await iterator.next(), { done: false, value: opened });
        }
        await within(1000, assert.rejects(iterator.next(), isAbortedWith(reason)), variant);
        assert.equal(parses.count(), 0, "no fixture frame is parsed after the abort");
        assert.equal(decodes.decoded(cancelled), false, "the settled chunk is not decoded");
        assert.deepEqual(await iterator.next(), { done: true, value: undefined });
      } finally {
        parses.restore();
        decodes.restore();
      }
      assert.equal(transportSignal?.reason, reason);
      assert.equal(source.cancellations(), 1);
      assert.equal(source.body.locked, false);
      assert.equal(listeners(), 0);
    });
  }

  test("an end-of-stream read that settles just before the abort delivers no final event", async () => {
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    // The compatibility frame has no closing blank line, so it is only parsed
    // once the end-of-stream read has been processed.
    const text = `data: ${JSON.stringify({ ...clicked, note: marker })}`;
    const source = settleThenAbortBody(
      [encoder.encode(text), "close"],
      1,
      () => controller.abort("fixture: abort after end-of-stream read"),
    );
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(source.body) });
    const parses = countParses(ssePayloads(text));
    try {
      await within(1000, assert.rejects(collect(client.events.stream({ signal: controller.signal })), isAbortedWith("fixture: abort after end-of-stream read")), "end-of-stream read");
      assert.equal(parses.count(), 0);
    } finally {
      parses.restore();
    }
    assert.equal(source.body.locked, false);
    assert.equal(listeners(), 0);
  });

  test("an abort after the error-text helper finishes, before its caller resumes, skips JSON parsing", async () => {
    const errorText = JSON.stringify({ error: { code: marker, message: "fixture" } });
    const errorChunk = encoder.encode(errorText);
    const controller = new AbortController();
    const reason = new Error("fixture: abort at the error-text handoff");
    const listeners = countAbortListeners(controller.signal);
    const steps: string[] = [];
    const body = errorBodyWithReleaseHook(errorChunk, () => {
      steps.push("helper released its reader");
      queueMicrotask(() => {
        steps.push("abort");
        controller.abort(reason);
      });
    });
    const client = new PostwaveClient({
      authMode: "none",
      retries: 0,
      fetch: async () => new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
    });
    const parses = countParses([errorText]);
    const decodes = trackDecodes();
    try {
      await within(1000, assert.rejects(collect(client.events.stream({ signal: controller.signal })), isAbortedWith(reason)), "error-text handoff");
      // The helper finished: it decoded the whole body before the abort.
      assert.equal(decodes.decoded(errorChunk), true);
      assert.deepEqual(steps, ["helper released its reader", "abort"]);
      assert.equal(parses.count(), 0, "the error text is not JSON-parsed after the abort");
    } finally {
      parses.restore();
      decodes.restore();
    }
    assert.equal(body.locked, false);
    assert.equal(listeners(), 0);
  });

  for (const [variant, abortAt] of [["chunk", 0], ["end-of-stream", 1]] as const) {
    test(`an error-body ${variant} read that settles just before the abort is not decoded or parsed`, async () => {
      const errorText = JSON.stringify({ error: { code: marker, message: "fixture" } });
      const errorChunk = encoder.encode(errorText);
      const controller = new AbortController();
      const listeners = countAbortListeners(controller.signal);
      const source = settleThenAbortBody([errorChunk, "close"], abortAt, () => controller.abort("fixture: abort during error body"));
      const client = new PostwaveClient({
        authMode: "none",
        retries: 0,
        fetch: async () => new Response(source.body, { status: 500, headers: { "content-type": "application/json" } }),
      });
      const parses = countParses([errorText]);
      const decodes = trackDecodes();
      try {
        await within(1000, assert.rejects(collect(client.events.stream({ signal: controller.signal })), isAbortedWith("fixture: abort during error body")), `error-body ${variant}`);
        assert.equal(parses.count(), 0, "the error body is not parsed");
        if (variant === "chunk") assert.equal(decodes.decoded(errorChunk), false, "the settled chunk is not decoded");
      } finally {
        parses.restore();
        decodes.restore();
      }
      assert.equal(source.body.locked, false);
      assert.equal(listeners(), 0);
    });
  }
});

describe("offline: overlapping event streams on one client", { concurrency: 1 }, () => {
  const a1 = { ...opened, id: "a1" };
  const a2 = { ...opened, id: "a2" };
  const b1 = { ...clicked, id: "b1" };
  const b2 = { ...clicked, id: "b2" };
  const b3 = { ...clicked, id: "b3" };

  test("cancelling one stream leaves a stream with its own signal receiving events to a normal finish", async () => {
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
    assert.deepEqual(await streamA.next(), { done: false, value: a1 });
    assert.deepEqual(await streamB.next(), { done: false, value: b1 });

    const pendingA = streamA.next();
    const pendingB = streamB.next();
    const reasonA = new Error("fixture: cancel stream A only");
    controllerA.abort(reasonA);
    await within(1000, assert.rejects(pendingA, isAbortedWith(reasonA)), "stream A abort");

    b.push(frame(b2));
    assert.deepEqual(await pendingB, { done: false, value: b2 });
    b.push(frame(b3));
    b.close();
    assert.deepEqual(await streamB.next(), { done: false, value: b3 });
    assert.deepEqual(await streamB.next(), { done: true, value: undefined });

    assert.equal(controllerB.signal.aborted, false);
    assert.notEqual(transportSignals.a, transportSignals.b);
    assert.equal(transportSignals.a?.reason, reasonA);
    assert.equal(transportSignals.b?.aborted, false);
    assert.equal(a.cancellations(), 1);
    assert.equal(b.cancellations(), 0);
    assert.equal(a.body.locked, false);
    assert.equal(b.body.locked, false);
    assert.equal(listenersA(), 0);
    assert.equal(listenersB(), 0);
  });

  test("aborting a shared signal rejects both streams with the original reason", async () => {
    const a = controlledBody();
    const b = controlledBody();
    const { client, transportSignals } = sharedClient({ a: a.body, b: b.body });
    const shared = new AbortController();
    const listeners = countAbortListeners(shared.signal);
    const streamA = client.events.stream({ event_type: "a", signal: shared.signal })[Symbol.asyncIterator]();
    const streamB = client.events.stream({ event_type: "b", signal: shared.signal })[Symbol.asyncIterator]();
    a.push(frame(a1));
    b.push(frame(b1) + frame(b2));
    assert.deepEqual(await streamA.next(), { done: false, value: a1 });
    assert.deepEqual(await streamB.next(), { done: false, value: b1 });
    assert.equal(listeners(), 2);

    // A is waiting on a read; B is paused, holding b1 with b2 already buffered.
    const pendingA = streamA.next();
    const reason = new Error("fixture: shared cancel");
    shared.abort(reason);
    assert.equal(b.cancellations(), 1, "the paused stream's body is cancelled at once");
    await within(1000, assert.rejects(pendingA, isAbortedWith(reason)), "stream A");
    await assert.rejects(streamB.next(), isAbortedWith(reason));

    assert.deepEqual(await streamA.next(), { done: true, value: undefined });
    assert.deepEqual(await streamB.next(), { done: true, value: undefined });
    assert.notEqual(transportSignals.a, transportSignals.b);
    assert.equal(transportSignals.a?.reason, reason);
    assert.equal(transportSignals.b?.reason, reason);
    assert.equal(a.cancellations(), 1);
    assert.equal(a.body.locked, false);
    assert.equal(b.body.locked, false);
    assert.equal(listeners(), 0);
  });

  for (const exit of ["break", "finish", "error"] as const) {
    test(`a stream that ends by ${exit} leaves a shared caller signal and the other stream untouched`, async () => {
      const a = controlledBody();
      const b = controlledBody();
      const { client, transportSignals } = sharedClient({ a: a.body, b: b.body });
      const shared = new AbortController();
      const listeners = countAbortListeners(shared.signal);
      const streamB = client.events.stream({ event_type: "b", signal: shared.signal })[Symbol.asyncIterator]();
      b.push(frame(b1));
      assert.deepEqual(await streamB.next(), { done: false, value: b1 });

      a.push(frame(a1) + frame(a2));
      if (exit === "finish") a.close();
      const dropped = new TypeError("fixture: stream A connection reset");
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
      assert.equal(failure, exit === "error" ? dropped : undefined);
      assert.deepEqual(receivedA, exit === "break" ? [a1] : [a1, a2]);
      assert.equal(shared.signal.aborted, false, "the caller's signal is never aborted by the SDK");
      assert.equal(listeners(), 1, "only stream B's listener remains");
      assert.equal(transportSignals.a?.aborted, exit !== "finish", "only an early exit aborts A's own transport signal");
      assert.equal(transportSignals.b?.aborted, false);
      assert.equal(a.cancellations(), exit === "break" ? 1 : 0);
      assert.equal(a.body.locked, false);

      b.push(frame(b2));
      assert.deepEqual(await streamB.next(), { done: false, value: b2 });
      b.close();
      assert.deepEqual(await streamB.next(), { done: true, value: undefined });
      assert.equal(shared.signal.aborted, false);
      assert.equal(transportSignals.b?.aborted, false);
      assert.equal(b.cancellations(), 0);
      assert.equal(b.body.locked, false);
      assert.equal(listeners(), 0);
    });
  }
});

describe("offline: event stream decoding follows demand", { concurrency: 1 }, () => {
  const W = DECODE_WINDOW_BYTES;

  test("a large chunk is decoded one window at a time, only as far as the next event", async () => {
    const frames = Array.from({ length: 10_000 }, (_, i) => frame({ ...opened, event_type: "decode-demand", id: `evt_${i}` }));
    const chunk = encoder.encode(frames.join(""));
    assert.ok(chunk.byteLength >= 32 * W, "the fixture spans many decode windows");
    const ends = frameEnds(frames);
    const source = nativeBody([chunk], { live: true });
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(source.body) });
    const decodes = trackDecodes();
    try {
      const iterator = client.events.stream()[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) {
        assert.equal((await iterator.next()).value?.id, `evt_${i}`);
        const decoded = decodes.decodedBytes(chunk);
        assert.ok(decoded >= ends[i]!, `next() #${i + 1}: the bytes it needed were decoded (${decoded})`);
        assert.ok(decoded <= ends[i]! + W, `next() #${i + 1}: at most one window beyond them (${decoded})`);
      }
      const decodedBeforeStop = decodes.decodedBytes(chunk);
      await iterator.return?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(decodes.decodedBytes(chunk), decodedBeforeStop, "nothing is decoded after the consumer stops");
    } finally {
      decodes.restore();
    }
    assert.equal(source.cancellations(), 1);
    assert.equal(source.body.locked, false);
  });

  test("frames larger than a window are decoded window by window, and stopping early decodes no further", async () => {
    const frames = Array.from({ length: 20 }, (_, i) => frame({ ...opened, event_type: "decode-large", id: `big_${i}`, metadata: { pad: "é".repeat(40_000) } }));
    const chunk = encoder.encode(frames.join(""));
    const ends = frameEnds(frames);
    assert.ok(ends[0]! > 8 * W, "each frame spans several windows");
    const source = nativeBody([chunk], { live: true });
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(source.body) });
    const decodes = trackDecodes();
    try {
      const received: Array<string | undefined> = [];
      for await (const record of client.events.stream()) {
        received.push(record.id);
        const decoded = decodes.decodedBytes(chunk);
        const i = received.length - 1;
        assert.ok(decoded >= ends[i]! && decoded <= ends[i]! + W, `after event ${i + 1}: decoded ${decoded}`);
        if (received.length === 2) break;
      }
      assert.deepEqual(received, ["big_0", "big_1"]);
      assert.ok(decodes.decodedBytes(chunk) <= ends[1]! + W);
      assert.ok(chunk.byteLength - decodes.decodedBytes(chunk) > 16 * W, "most of the chunk is never decoded");
    } finally {
      decodes.restore();
    }
    assert.equal(source.cancellations(), 1);
  });

  test("positive control with sliced buffers: every byte of each view is decoded exactly once, nothing outside", async () => {
    const frames = Array.from({ length: 2_000 }, (_, i) => frame({ ...clicked, id: `s_${i}`, metadata: { label: "café 🌊 中文" } }));
    const expected = frames.map((_, i) => ({ ...clicked, id: `s_${i}`, metadata: { label: "café 🌊 中文" } }));
    const bytes = encoder.encode(frames.join(""));
    assert.ok(bytes.byteLength > 16 * W);
    // Cut points inside multi-byte characters, near and far from window boundaries.
    const midChar = (from: number) => { let at = from; while (!isContinuationByte(bytes, at)) at++; return at; };
    const cuts = [0, midChar(W - 2), midChar(3 * W + 100), midChar(9 * W - 1), midChar(12 * W + 7), bytes.byteLength];
    // Lay the slices out in one buffer with invalid UTF-8 guard bytes around each.
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
    // Existing chunk kinds keep working: one slice as a DataView, one as a plain ArrayBuffer.
    const asDataView = new DataView(views[1]!.buffer, views[1]!.byteOffset, views[1]!.byteLength);
    const asArrayBuffer = views[3]!.slice().buffer;
    const chunks: unknown[] = [views[0], asDataView, views[2], asArrayBuffer, views[4]];
    const source = nativeBody(chunks);
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(source.body) });
    const decodes = trackDecodes();
    try {
      assert.deepEqual(await collect(client.events.stream()), expected);
      for (const [i, view] of views.entries()) {
        const measured = i === 3 ? new Uint8Array(asArrayBuffer) : view;
        assert.equal(decodes.decodedBytes(measured), view.byteLength, `slice ${i} decoded exactly once`);
      }
      for (const [i, guard] of guards.entries()) assert.equal(decodes.decodedBytes(guard), 0, `guard ${i} never decoded`);
    } finally {
      decodes.restore();
    }
  });

  test("characters and CRLF split by window or chunk boundaries decode as if contiguous", async () => {
    const expected: EventRecord[] = [];
    const straddled: number[] = [];
    let text = "";
    for (const char of ["é", "中", "🌊"]) {
      for (let shift = 1; shift < utf8Length(char); shift++) {
        const id = `width${utf8Length(char)}-shift${shift}`;
        const next = frameAcrossWindow(utf8Length(text), char, shift, id);
        const record = JSON.parse(next.slice("data: ".length)) as EventRecord;
        const charAt = utf8Length(text) + utf8Length(next.slice(0, next.indexOf(char)));
        straddled.push(charAt + shift);
        expected.push(record);
        text += next;
      }
    }
    // A multi-line frame whose CRLF is split by a window boundary: CR is the
    // window's last byte, LF the next window's first. Two line breaks would
    // end the frame early and lose the event.
    const crlfRecord = { ...clicked, id: "crlf", metadata: { pad: "" } };
    const head = (pad: number) => `data: ${JSON.stringify({ ...crlfRecord, metadata: { pad: "x".repeat(pad) } }).slice(0, -1)},`;
    const offset = utf8Length(text);
    const pad = Math.ceil((offset + utf8Length(head(0)) + 1) / W) * W - 1 - offset - utf8Length(head(0));
    text += `${head(pad)}\r\ndata: "tail":"ok"}\r\n\r\n`;
    straddled.push(offset + utf8Length(head(pad)) + 1);
    expected.push({ ...crlfRecord, metadata: { pad: "x".repeat(pad) }, tail: "ok" } as EventRecord);
    // End of stream: a final frame without its blank line, then bytes cut mid-character.
    text += `data: ${JSON.stringify({ ...opened, id: "eof-compat", metadata: { label: "🌊".repeat(3_000) } })}`;
    expected.push({ ...opened, id: "eof-compat", metadata: { label: "🌊".repeat(3_000) } });
    const bytes = Uint8Array.of(...encoder.encode(text));
    for (const at of straddled.slice(0, -1)) {
      assert.equal(at % W, 0, "fixture: a window boundary");
      assert.ok(isContinuationByte(bytes, at), `fixture: window boundary ${at} is inside a character`);
    }
    assert.equal(bytes[straddled.at(-1)! - 1], 0x0d);
    assert.equal(bytes[straddled.at(-1)!], 0x0a);

    const splits = [
      [bytes],
      straddled.map((at, i) => bytes.slice(i === 0 ? 0 : straddled[i - 1]! - 1, at - 1)).concat([bytes.slice(straddled.at(-1)! - 1)]),
      chunked(bytes, 4093),
      chunked(bytes, W + 1),
    ];
    for (const [i, chunks] of splits.entries()) {
      assert.deepEqual(await collect(bytesClient(chunks).events.stream()), expected, `delivery ${i}`);
    }
    const truncated = Uint8Array.of(...encoder.encode(frame(opened)), 0xf0, 0x9f, 0x8c);
    assert.deepEqual(await collect(bytesClient([truncated]).events.stream()), [opened], "a cut-off final character is ignored as before");
  });

  test("after an abort nothing more is decoded or parsed, and the tracker would have seen it (negative control)", async () => {
    const text = bulkFrames(10_000, "decode-abort");
    const chunk = encoder.encode(text);
    const source = nativeBody([chunk], { live: true });
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);
    const client = new PostwaveClient({ authMode: "none", fetch: async () => new Response(source.body) });
    const decodes = trackDecodes();
    const parses = countParses(ssePayloads(text));
    try {
      const iterator = client.events.stream({ signal: controller.signal })[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.id, "evt_0");
      const decodedAtAbort = decodes.decodedBytes(chunk);
      const parsedAtAbort = parses.count();
      assert.ok(decodedAtAbort > 0 && decodedAtAbort <= W, "positive control: the first event's decoding was seen");
      controller.abort("fixture: abort with most of the chunk undecoded");
      assert.equal(source.cancellations(), 1);
      await assert.rejects(iterator.next(), isAbortedWith("fixture: abort with most of the chunk undecoded"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(decodes.decodedBytes(chunk), decodedAtAbort, "no decoding after the abort");
      assert.equal(parses.count(), parsedAtAbort, "no parsing after the abort");
      // Negative control: the unwanted work these assertions rule out,
      // done deliberately, is measured by the same instruments.
      new TextDecoder().decode(chunk.subarray(decodedAtAbort, decodedAtAbort + W));
      assert.equal(decodes.decodedBytes(chunk), decodedAtAbort + W, "the tracker sees decoding of the remaining bytes");
      JSON.parse(ssePayloads(text)[9_999]!);
      assert.equal(parses.count(), parsedAtAbort + 1, "the parse counter sees parsing of a remaining frame");
    } finally {
      decodes.restore();
      parses.restore();
    }
    assert.equal(source.body.locked, false);
    assert.equal(listeners(), 0);
  });

  test("interleaved streams keep separate decoder state and separate bounds; aborting one stops only its decoding", async () => {
    const build = (prefix: string, char: string) => Array.from({ length: 400 }, (_, i) => frame({ ...opened, event_type: prefix, id: `${prefix}_${i}`, metadata: { text: char.repeat(300 + (i % 7)) } }));
    const framesA = build("a", "🌊");
    const framesB = build("b", "中");
    const chunkA = encoder.encode(framesA.join(""));
    const chunkB = encoder.encode(framesB.join(""));
    const endsA = frameEnds(framesA);
    const endsB = frameEnds(framesB);
    for (const bytes of [chunkA, chunkB]) {
      assert.ok(bytes.byteLength > 32 * W);
      assert.ok([1, 2, 3].some((k) => isContinuationByte(bytes, k * W)), "fixture: a window boundary falls inside a character");
    }
    const a = nativeBody([chunkA], { live: true });
    const b = nativeBody([chunkB]);
    const { client } = sharedClient({ a: a.body, b: b.body });
    const controllerA = new AbortController();
    const decodes = trackDecodes();
    try {
      const streamA = client.events.stream({ event_type: "a", signal: controllerA.signal })[Symbol.asyncIterator]();
      const streamB = client.events.stream({ event_type: "b" })[Symbol.asyncIterator]();
      // Alternate event by event across many window boundaries of both.
      for (let i = 0; i < 60; i++) {
        const fromA = await streamA.next();
        const fromB = await streamB.next();
        assert.deepEqual(fromA.value, JSON.parse(framesA[i]!.slice("data: ".length)));
        assert.deepEqual(fromB.value, JSON.parse(framesB[i]!.slice("data: ".length)));
        const decodedA = decodes.decodedBytes(chunkA);
        const decodedB = decodes.decodedBytes(chunkB);
        assert.ok(decodedA >= endsA[i]! && decodedA <= endsA[i]! + W, `stream A after ${i + 1} events: ${decodedA}`);
        assert.ok(decodedB >= endsB[i]! && decodedB <= endsB[i]! + W, `stream B after ${i + 1} events: ${decodedB}`);
      }
      const decodedAAtAbort = decodes.decodedBytes(chunkA);
      controllerA.abort("fixture: abort stream A");
      await assert.rejects(streamA.next(), isAbortedWith("fixture: abort stream A"));
      const restB: EventRecord[] = [];
      for (let r = await streamB.next(); !r.done; r = await streamB.next()) restB.push(r.value);
      assert.equal(restB.length, 400 - 60);
      assert.equal(restB.at(-1)?.id, "b_399");
      assert.equal(decodes.decodedBytes(chunkA), decodedAAtAbort, "stream A decodes nothing after its abort");
      assert.equal(decodes.decodedBytes(chunkB), chunkB.byteLength, "stream B decodes every byte exactly once");
    } finally {
      decodes.restore();
    }
    assert.equal(a.cancellations(), 1);
    assert.equal(b.cancellations(), 0);
  });
});

describe("offline: event stream frame limit, Unicode and a leading BOM", { concurrency: 1 }, () => {
  const LIMIT = 256 * 1024; // UTF-16 code units, not bytes
  const W = DECODE_WINDOW_BYTES;

  test("a leading BOM, whole or fragmented, is not counted toward the first frame, and an oversized frame is still skipped", async () => {
    const atLimit = lineOfUnits(LIMIT, "x", "at-limit");
    const phantom = { ...opened, event_type: "phantom" };
    const phantomLine = `data: ${JSON.stringify(phantom)}`;
    const oversizedHead = `data: ${"y".repeat(LIMIT + 1 - 1 - phantomLine.length - "data: ".length)}`;
    const oversized = `${oversizedHead}\n${phantomLine}`;
    assert.equal(atLimit.line.length, LIMIT, "fixture: first frame exactly at the limit");
    assert.equal(oversized.length, LIMIT + 1, "fixture: second frame one unit over");
    const body = encoder.encode(`${atLimit.line}\n\n${oversized}\n\n${frame(clicked)}`);
    const bytes = concatBytes(UTF8_BOM, body);
    const head = Array.from({ length: 12 }, (_, i) => bytes.subarray(i, i + 1));
    const deliveries: Array<[string, Uint8Array[]]> = [
      ["one chunk", [bytes]],
      ["BOM byte by byte after an empty chunk", [new Uint8Array(0), bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2, 3), bytes.subarray(3)]],
      ["first 12 bytes one at a time, then 4093-byte chunks", [...head, ...chunked(bytes.subarray(12), 4093)]],
      ["window-plus-one chunks", chunked(bytes, W + 1)],
    ];
    for (const [label, chunks] of deliveries) {
      assert.deepEqual(await collect(bytesClient(chunks).events.stream()), [atLimit.record, clicked], label);
    }
    // Only one leading BOM is ignored, as before: a second U+FEFF is content,
    // so the first line's field is not `data` and that frame yields nothing.
    const doubled = concatBytes(UTF8_BOM, UTF8_BOM, encoder.encode(frame(opened) + frame(clicked)));
    assert.deepEqual(await collect(bytesClient([doubled]).events.stream()), [clicked]);
    assert.deepEqual(await collect(bytesClient(chunked(doubled, 1)).events.stream()), [clicked]);
  });

  test("a U+FEFF after an oversized frame is content, not a BOM: only the tail event is emitted", async () => {
    const afterBom = { ...opened, event_type: "after-bom" };
    const tail = { ...clicked, event_type: "tail" };
    // The U+FEFF right after the oversized frame, then placed to start a
    // decode window, then to straddle one (ASCII: units equal bytes).
    for (const bomAt of [undefined, 33 * W, 33 * W - 1]) {
      const oversizedUnits = bomAt === undefined ? LIMIT + 1 : bomAt - 2;
      const oversized = `data: ${"x".repeat(oversizedUnits - "data: ".length)}`;
      const bytes = encoder.encode(`${oversized}\n\n\uFEFFdata: ${JSON.stringify(afterBom)}\n\n${frame(tail)}`);
      const at = utf8Length(`${oversized}\n\n`);
      const label = bomAt === undefined ? "U+FEFF after the frame" : bomAt % W === 0 ? "U+FEFF starts a window" : "U+FEFF straddles a window";
      assert.ok(oversized.length > LIMIT, `fixture (${label}): the first frame is oversized`);
      assert.deepEqual([...bytes.subarray(at, at + 3)], [0xef, 0xbb, 0xbf], `fixture (${label}): U+FEFF bytes`);
      if (bomAt !== undefined) assert.equal(at, bomAt, `fixture (${label}): U+FEFF position`);
      const deliveries: Array<[string, Uint8Array[]]> = [
        ["one chunk", [bytes]],
        ["a chunk starts at U+FEFF", [bytes.subarray(0, at), bytes.subarray(at)]],
        ["U+FEFF split 1|2", [bytes.subarray(0, at + 1), bytes.subarray(at + 1)]],
        ["U+FEFF split 2|1", [bytes.subarray(0, at + 2), bytes.subarray(at + 2)]],
        ["byte by byte around U+FEFF", [bytes.subarray(0, at - 4), ...Array.from({ length: 16 }, (_, i) => bytes.subarray(at - 4 + i, at - 3 + i)), bytes.subarray(at + 12)]],
        ["window-plus-one chunks", chunked(bytes, W + 1)],
      ];
      for (const [how, chunks] of deliveries) {
        assert.deepEqual(await collect(bytesClient(chunks).events.stream()), [tail], `${label}, ${how}`);
      }
    }
  });

  test("the frame limit counts UTF-16 code units, not UTF-8 bytes", async () => {
    const expected: EventRecord[] = [];
    let text = "";
    for (const char of ["é", "中", "🌊"]) {
      const atLimit = lineOfUnits(LIMIT, char, `at-limit ${char}`);
      const overLimit = lineOfUnits(LIMIT + 1, char, `over-limit ${char}`);
      assert.ok(utf8Length(atLimit.line) > LIMIT * 1.9, `fixture: ${char} frame at the limit is far over ${LIMIT} bytes`);
      text += `${atLimit.line}\n\n${overLimit.line}\n\n`;
      expected.push(atLimit.record);
    }
    text += frame(clicked);
    expected.push(clicked);
    const bytes = encoder.encode(text);
    for (const [label, chunks] of [["one chunk", [bytes]], ["window-plus-one chunks", chunked(bytes, W + 1)], ["4093-byte chunks", chunked(bytes, 4093)]] as const) {
      assert.deepEqual(await collect(bytesClient([...chunks]).events.stream()), expected, label);
    }
  });

  test("a surrogate pair that completes exactly at the limit is kept; one that crosses it drops the frame", async () => {
    const dataLine = `data: ${JSON.stringify({ ...opened, id: "surrogate" })}`;
    // frame = data line + "\n" + comment line ending in U+1F30A (two units).
    const frameOf = (units: number) => `${dataLine}\n: ${"z".repeat(units - dataLine.length - 1 - ": ".length - 2)}🌊`;
    const kept = frameOf(LIMIT);
    const dropped = frameOf(LIMIT + 1);
    assert.equal(kept.length, LIMIT);
    assert.equal(dropped.length, LIMIT + 1);
    for (const [label, text, expected] of [["completes at the limit", kept, [{ ...opened, id: "surrogate" }, clicked]], ["crosses the limit", dropped, [clicked]]] as const) {
      const bytes = encoder.encode(`${text}\n\n${frame(clicked)}`);
      const emojiEnd = utf8Length(text);
      const deliveries = [[bytes], [bytes.subarray(0, emojiEnd - 2), bytes.subarray(emojiEnd - 2)], chunked(bytes, W + 1)];
      for (const [i, chunks] of deliveries.entries()) {
        assert.deepEqual(await collect(bytesClient(chunks).events.stream()), expected, `${label}, delivery ${i}`);
      }
    }
  });
});

