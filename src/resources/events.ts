// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";
import { mapError, NetworkError, RequestAbortedError } from "../errors.js";
import { discardBody, raceAbort } from "../lib/lifecycle.js";

const MAX_STREAM_ERROR_TEXT_BYTES = 64 * 1024;
/**
 * Largest SSE frame the stream will parse, in UTF-16 code units (JavaScript
 * string length) of decoded text, NOT UTF-8 bytes. Counted over all of the
 * frame's lines (comments and other fields included), with each line break
 * counting one whatever its form, excluding the blank line that ends it. A
 * character outside the Basic Multilingual Plane counts two. A leading BOM
 * is removed by the decoder and never counts. In bytes, a frame at the limit
 * is 262,144 bytes of ASCII but up to about three times that of 3-byte
 * characters. Larger frames are skipped up to the blank line that ends them.
 * This also bounds the text the parser buffers, whatever the chunk sizes.
 */
const MAX_STREAM_FRAME_CHARS = 256 * 1024;
/**
 * @internal Most bytes of a transport chunk decoded at a time. Decoding
 * follows demand: the next window is decoded only when the parser needs more
 * text to reach the next event, so one `next()` decodes at most this much
 * beyond the end of the frame it returns. Not part of the public API.
 */
export const DECODE_WINDOW_BYTES = 8 * 1024;

/** A live email event streamed via SSE. */
export interface EventRecord {
  id?: string;
  ts: string;
  event_type: string;
  subscriber_email?: string;
  campaign_id?: string;
  subscriber_id?: string;
  metadata?: Record<string, unknown>;
}

export interface StreamParams {
  /** Optional event_type filter (e.g. "opened"). */
  event_type?: string;
  /** Optional campaign filter. */
  campaign?: string;
  /**
   * Abort signal to stop the stream. Once it aborts, whether before the
   * request is sent, while connecting, while reading, or while your loop
   * body runs, the pending or next `next()` rejects with
   * `RequestAbortedError` (the abort reason is its `payload`), nothing
   * further is decoded, parsed or yielded, and the response body is
   * cancelled. This holds even for a transport that ignores its signal.
   */
  signal?: AbortSignal;
}

/**
 * Live events resource. Connects to the server's SSE stream
 * `GET /api/v1/events/stream` and yields parsed event records.
 */
export interface SubscribeInput {
  event_types?: string[];
  campaign_id?: string;
  subscriber_email?: string;
}

export interface SubscribeResponse {
  subscription_id: string;
  resource_uri: string;
}

export class EventsResource extends Resource {
  /**
   * Register a declarative event subscription. Returns a subscription_id and
   * a `moosewave://events/stream` URI scoped to the requested filters.
   */
  subscribe(input: SubscribeInput): Promise<SubscribeResponse> {
    return this.client.request("POST", "/api/v1/events/subscriptions", {
      body: input,
    });
  }

  /**
   * Open the live event stream and yield each valid event record.
   *
   * Parsing does not depend on how the transport chunks the body, and both
   * decoding and parsing are driven by demand: each `next()` decodes (in
   * windows of at most 8 KiB) and parses only as far as the next valid
   * event, so a large chunk is not decoded or turned into records the
   * consumer may never ask for. Frames that are malformed, shape-invalid or
   * longer than 262,144 UTF-16 code units (JavaScript string length, not
   * UTF-8 bytes) are skipped, and parsing resumes at the next frame.
   *
   * The request is sent on the first `next()`; nothing is sent if `signal`
   * has aborted by then. Once it aborts, at any later point (connecting,
   * reading, or while your loop body runs, including after the final
   * event), the pending or next `next()` rejects with `RequestAbortedError`,
   * even with a transport that ignores its signal. Nothing is decoded,
   * parsed or yielded after the abort, including data from a read that
   * settled just before it. Every exit releases the reader, and every exit
   * before the end of the body also cancels it.
   */
  async *stream(params: StreamParams = {}): AsyncIterable<EventRecord> {
    const callerSignal = params.signal;
    if (callerSignal?.aborted) {
      throw new RequestAbortedError({ payload: callerSignal.reason });
    }
    const query: Record<string, string | undefined> = {
      event_type: params.event_type,
      campaign: params.campaign,
    };
    const url = this.client.buildRequestUrl("/api/v1/events/stream", query);
    const headers = this.client.buildRequestHeaders({
      Accept: "text/event-stream",
    });

    const lifecycle = new StreamLifecycle(callerSignal);
    let completed = false;
    try {
      // Owned from the moment it resolves: an abort that lands before the
      // reader exists still cancels its body.
      const resp = lifecycle.own(
        await raceAbort(
          Promise.resolve(
            this.client.fetchRaw(url, {
              method: "GET",
              headers,
              signal: lifecycle.signal,
              credentials: this.client.credentials,
            }),
          ),
          lifecycle.signal,
          discardBody,
        ),
      );
      lifecycle.throwIfCancelled();
      if (!resp.ok) {
        const body = await readStreamErrorBody(resp, lifecycle.signal);
        lifecycle.throwIfCancelled();
        throw mapError(
          resp.status,
          body,
          resp.headers.get("x-request-id") ?? undefined,
        );
      }
      if (!resp.body) {
        throw new NetworkError({
          message: "events.stream: response body is not readable",
        });
      }

      const reader = lifecycle.attach(resp.body.getReader());
      const input = lifecycle.attachInput(new DemandDecoder());
      const parser = new SseEventParser();
      let ended = false;
      while (true) {
        // Every pass starts here: before the first read, after each read,
        // and when the consumer resumes after a yield (including after the
        // final event). Once the caller has aborted, nothing more is parsed
        // or yielded, and the abort is reported rather than completing.
        lifecycle.throwIfCancelled();
        // Parse only up to the next record. The rest of the chunk waits
        // until the consumer asks again, and is never parsed if it stops.
        const record = parser.take() ?? (ended ? parser.end() : undefined);
        if (record !== undefined) {
          yield record;
          continue;
        }
        if (ended) break;
        // Decode only as much of the held chunk as the parser needs: one
        // window, then back to the top (cancellation check, then parse).
        if (input.pending) {
          parser.feed(input.decodeNext());
          continue;
        }
        const { done, value } = await raceAbort(reader.read(), lifecycle.signal);
        // A read can settle just before an abort, and win the race. What it
        // returned belongs to a cancelled stream: dropped, not decoded.
        lifecycle.throwIfCancelled();
        if (done) {
          ended = true;
          parser.feed(input.flush());
        } else {
          input.load(value);
        }
      }
      completed = true;
    } catch (err) {
      throw lifecycle.normalizeError(err);
    } finally {
      lifecycle.close(completed);
    }
  }
}

/**
 * Cancellation and cleanup for one `events.stream()` call.
 *
 * The transport gets a stream-owned signal linked to the caller's, so the
 * SDK can also end the request when the consumer stops early. Every await on
 * the transport (connect, body reads, error-body reads) is raced against that
 * signal, because a custom transport may ignore it.
 *
 * The lifecycle owns the response from the moment the transport resolves,
 * and its reader once attached. Whichever it holds is released when the
 * caller aborts (even if the consumer is paused inside its loop body and
 * never resumes the iterator) and on every exit.
 */
class StreamLifecycle {
  private readonly caller: AbortSignal | undefined;
  private readonly controller = new AbortController();
  private response: Response | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private input: DemandDecoder | undefined;
  private readonly onCallerAbort = (): void => {
    this.controller.abort(this.caller?.reason);
    this.release();
  };

  constructor(caller: AbortSignal | undefined) {
    this.caller = caller;
    caller?.addEventListener("abort", this.onCallerAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Take ownership of the transport's response. If the caller aborted
   * between the transport resolving and this call, the abort listener had
   * nothing to release, so the body is released here.
   */
  own(response: Response): Response {
    this.response = response;
    if (this.caller?.aborted) this.release();
    return response;
  }

  /** The reader now holds the body; releasing cancels through it. */
  attach(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): ReadableStreamDefaultReader<Uint8Array> {
    this.reader = reader;
    this.response = undefined;
    return reader;
  }

  /** Held, undecoded input is dropped on release, not kept until resumed. */
  attachInput(input: DemandDecoder): DemandDecoder {
    this.input = input;
    return input;
  }

  throwIfCancelled(): void {
    if (this.caller?.aborted) {
      throw new RequestAbortedError({ payload: this.caller.reason });
    }
  }

  /** A caller abort wins over whatever the transport threw for it. */
  normalizeError(err: unknown): unknown {
    if (this.caller?.aborted && !(err instanceof RequestAbortedError)) {
      return new RequestAbortedError({ payload: this.caller.reason });
    }
    return err;
  }

  /** Idempotent. `completed`: the body was read to its end. */
  close(completed: boolean): void {
    this.caller?.removeEventListener("abort", this.onCallerAbort);
    if (!completed && !this.controller.signal.aborted) this.controller.abort();
    this.release();
  }

  private release(): void {
    this.input?.release();
    this.input = undefined;
    const response = this.response;
    this.response = undefined;
    // Skipped when the body is locked or used: an error-body read holds it
    // and releases it itself.
    if (response) discardBody(response);

    const reader = this.reader;
    if (!reader) return;
    this.reader = undefined;
    // Not awaited: a body whose cancel() never settles must not hang the
    // consumer's `break`. Cancelling settles any pending read first, so the
    // lock can be released straight after.
    try {
      reader.cancel().catch(noop);
    } catch {
      /* noop */
    }
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function noop(): void {
  /* intentionally empty */
}

/**
 * Rethrow an abort that raced a settled await. `signal.reason` is thrown so
 * the stream reports it as the caller's RequestAbortedError.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/**
 * UTF-8 decoding that follows demand.
 *
 * `load()` holds a transport chunk by reference, undecoded. Each
 * `decodeNext()` decodes the next window of at most DECODE_WINDOW_BYTES
 * (a `subarray` view, not a copy) through one streaming TextDecoder, so a
 * character split across a window or chunk boundary decodes exactly as if the
 * bytes were contiguous. The stream calls it only when the parser has run out
 * of text, so bytes past the next event stay undecoded until asked for, and
 * are never decoded if the consumer stops or the caller aborts.
 *
 * Chunks other than Uint8Array keep their previous handling: other views and
 * ArrayBuffers are viewed as bytes without copying, and anything else goes
 * straight to TextDecoder, which decodes or rejects it exactly as before.
 */
class DemandDecoder {
  private readonly decoder = new TextDecoder("utf-8");
  private bytes: Uint8Array | undefined;
  private offset = 0;
  /** Text from a non-buffer chunk, decoded eagerly as before. */
  private text: string | undefined;

  /** Whether part of the held chunk is still undecoded. */
  get pending(): boolean {
    return this.text !== undefined || this.bytes !== undefined;
  }

  /** Hold the next chunk. Call only once `pending` is false. */
  load(chunk: unknown): void {
    const bytes = asBytes(chunk);
    if (bytes === undefined) {
      this.text = this.decoder.decode(chunk as BufferSource | undefined, { stream: true });
      return;
    }
    if (bytes.byteLength === 0) return;
    this.bytes = bytes;
    this.offset = 0;
  }

  /** Decode the next window of the held chunk. Only while `pending`. */
  decodeNext(): string {
    if (this.text !== undefined) {
      const text = this.text;
      this.text = undefined;
      return text;
    }
    const bytes = this.bytes;
    if (bytes === undefined) return "";
    const end = Math.min(this.offset + DECODE_WINDOW_BYTES, bytes.byteLength);
    const window = bytes.subarray(this.offset, end);
    this.offset = end;
    // Drop the chunk as soon as its last window is decoded.
    if (end === bytes.byteLength) this.bytes = undefined;
    return this.decoder.decode(window, { stream: true });
  }

  /** End of stream: the decoder's final output (U+FFFD for a cut-off character). */
  flush(): string {
    this.release();
    return this.decoder.decode();
  }

  /** Drop any held, undecoded input. */
  release(): void {
    this.bytes = undefined;
    this.text = undefined;
  }
}

/** A byte view of a buffer chunk, without copying; undefined for anything else. */
function asBytes(chunk: unknown): Uint8Array | undefined {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (
    chunk instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && chunk instanceof SharedArrayBuffer)
  ) {
    return new Uint8Array(chunk);
  }
  return undefined;
}

/**
 * Incremental, pull-based Server-Sent Events parser for the event stream.
 *
 * `feed()` hands it one decoded chunk. Each `take()` then scans that chunk
 * only as far as the next valid record and returns it, keeping its position.
 * A chunk holding thousands of events therefore costs one frame's work per
 * record delivered, and nothing for records never asked for. Frames that
 * yield no record (malformed, shape-invalid, comments only) are skipped
 * within the same `take()`.
 *
 * Works line by line over decoded text, so the outcome is the same however
 * the body is split: a CR at the end of one chunk and the LF that starts the
 * next form one CRLF line break, not two. Only `data` fields are used.
 * Comments and other fields are ignored, as before.
 *
 * A frame that grows past MAX_STREAM_FRAME_CHARS is dropped, and everything
 * up to the blank line that ends it is skipped. Its remaining lines are never
 * read as new frames.
 */
class SseEventParser {
  private readonly lineBreak = /\r\n|\r|\n/g;
  /** The chunk being parsed, and how far `take()` has got through it. */
  private text = "";
  private pos = 0;
  /** The current, unterminated line of a frame being kept. */
  private line = "";
  /** A chunk ended in CR; an LF starting the next chunk completes the CRLF. */
  private skipLeadingLf = false;
  private dataLines: string[] = [];
  /** Length of the current frame's lines joined by "\n". */
  private frameChars = 0;
  private frameLines = 0;
  /** Skipping the rest of an oversized frame. */
  private discarding = false;
  /** While discarding: the current line has content, so it is not blank. */
  private discardLineHasContent = false;

  /** Hand over the next decoded chunk. Call once `take()` is exhausted. */
  feed(text: string): void {
    this.text = text;
    this.pos = 0;
    if (text === "") return;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (text.charCodeAt(0) === 0x0a) this.pos = 1;
    }
  }

  /** The next valid record in the fed text, or undefined once it is used up. */
  take(): EventRecord | undefined {
    const text = this.text;
    const lineBreak = this.lineBreak;
    while (this.pos < text.length) {
      lineBreak.lastIndex = this.pos;
      const match = lineBreak.exec(text);
      if (match === null) {
        this.append(text, this.pos, text.length);
        this.pos = text.length;
        break;
      }
      this.append(text, this.pos, match.index);
      this.pos = match.index + match[0].length;
      if (match[0] === "\r" && this.pos === text.length) this.skipLeadingLf = true;
      const record = this.endLine();
      if (record !== undefined) return record;
    }
    this.text = "";
    this.pos = 0;
    return undefined;
  }

  /**
   * End of stream, once `take()` is exhausted. Compatibility: a final frame
   * that has data but no closing blank line is still parsed, as before,
   * unless it was being discarded. Returns undefined when called again.
   */
  end(): EventRecord | undefined {
    if (this.discarding) {
      this.reset();
      return undefined;
    }
    // A non-empty line never completes a frame by itself.
    if (this.line !== "") this.endLine();
    return this.dispatch();
  }

  private append(text: string, start: number, end: number): void {
    if (end <= start) return;
    if (this.discarding) {
      this.discardLineHasContent = true;
      return;
    }
    const frameChars =
      this.frameChars +
      (this.frameLines > 0 ? 1 : 0) +
      this.line.length +
      (end - start);
    if (frameChars > MAX_STREAM_FRAME_CHARS) {
      this.reset();
      this.discarding = true;
      this.discardLineHasContent = true;
      return;
    }
    this.line += text.slice(start, end);
  }

  /** Complete the current line. Returns a record when it ends a frame. */
  private endLine(): EventRecord | undefined {
    if (this.discarding) {
      // A blank line ends the oversized frame; parsing resumes after it.
      if (!this.discardLineHasContent) this.discarding = false;
      this.discardLineHasContent = false;
      return undefined;
    }
    const line = this.line;
    this.line = "";
    if (line === "") return this.dispatch();
    this.frameChars += (this.frameLines > 0 ? 1 : 0) + line.length;
    this.frameLines++;
    const colon = line.indexOf(":");
    if (colon === 0) return undefined; // comment
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return undefined;
    // Leading whitespace is insignificant to the JSON payload. trimStart()
    // (rather than the spec's single space) keeps the previous behavior.
    this.dataLines.push(colon < 0 ? "" : line.slice(colon + 1).trimStart());
    return undefined;
  }

  private dispatch(): EventRecord | undefined {
    const dataLines = this.dataLines;
    this.resetFrame();
    if (dataLines.length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      return undefined;
    }
    return normalizeEventRecord(parsed) ?? undefined;
  }

  private resetFrame(): void {
    this.dataLines = [];
    this.frameChars = 0;
    this.frameLines = 0;
  }

  private reset(): void {
    this.resetFrame();
    this.line = "";
    this.discarding = false;
    this.discardLineHasContent = false;
  }
}

function normalizeEventRecord(raw: unknown): EventRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.ts !== "string" || typeof raw.event_type !== "string") return null;

  const { metadata, ...rest } = raw;
  const record = {
    ...rest,
    ts: raw.ts,
    event_type: raw.event_type,
  } as EventRecord;

  if (metadata !== undefined) {
    if (!isRecord(metadata)) return null;
    record.metadata = metadata;
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort error payload for a non-2xx stream response, read under a byte
 * ceiling and bounded by `signal`. A body that is too large or fails to read
 * yields `undefined`, as before. An abort is rethrown, not swallowed. The
 * body is always released: cancelled unless read to the end, then unlocked.
 */
async function readStreamErrorBody(
  resp: Response,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const text = await readTextLimited(resp, MAX_STREAM_ERROR_TEXT_BYTES, signal);
    throwIfAborted(signal);
    if (!text) return undefined;
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (signal.aborted) throw err;
    return undefined;
  }
}

async function readTextLimited(
  resp: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = Number(resp.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    discardBody(resp);
    return "";
  }
  if (!resp.body) {
    const read = resp.text.bind(resp);
    const text = await raceAbort(read(), signal);
    throwIfAborted(signal);
    return new TextEncoder().encode(text).byteLength > maxBytes ? "" : text;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  let complete = false;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), signal);
      // A read that settled just before an abort is not decoded.
      throwIfAborted(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return "";
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    complete = true;
    return out;
  } finally {
    if (!complete) reader.cancel().catch(noop);
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}
