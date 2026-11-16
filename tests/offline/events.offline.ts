// SPDX-License-Identifier: MIT
/**
 * Event-stream compatibility baseline using only Node's built-in test runner.
 * Run npm run --offline test:events:offline without installing dependencies.
 * This covers existing behavior, not complete SSE conformance or transport
 * cancellation. Expand the regression coverage when stream behavior changes.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NotFoundError, PostwaveClient } from "../../src/index.js";
import type { EventRecord } from "../../src/resources/events.js";
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
