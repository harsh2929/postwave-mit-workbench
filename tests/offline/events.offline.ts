// SPDX-License-Identifier: MIT
// Dependency-free compatibility checks for the existing SSE API.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NotFoundError, PostwaveClient } from "../../src/index.js";
import type { EventRecord, FetchFn } from "../../src/index.js";
import { syntheticCredential } from "../fixture-data.js";

const record: EventRecord = { ts: "2026-11-16T00:00:00Z", event_type: "opened" };
const encoder = new TextEncoder();

function response(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function textResponse(...chunks: string[]): Response {
  return response(chunks.map((chunk) => encoder.encode(chunk)));
}

function client(fetch: FetchFn): PostwaveClient {
  return new PostwaveClient({ authMode: "none", retries: 0, fetch });
}

async function collect(iterable: AsyncIterable<EventRecord>): Promise<EventRecord[]> {
  const values: EventRecord[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("offline: event stream compatibility", { timeout: 5_000 }, () => {
  test("retains configured transport, filters, credentials and authentication", async () => {
    const key = syntheticCredential("stream-auth");
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const sdk = new PostwaveClient({
      apiKey: key,
      tenantId: "fixture-tenant",
      credentials: "include",
      defaultHeaders: { "X-Test-Client": "offline" },
      fetch: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return textResponse(`data: ${JSON.stringify(record)}\n\n`);
      },
    });
    assert.deepEqual(await collect(sdk.events.stream({ event_type: "opened", campaign: "fixture-campaign" })), [record]);
    const url = new URL(requestUrl);
    assert.equal(url.pathname, "/api/v1/events/stream");
    assert.equal(url.searchParams.get("event_type"), "opened");
    assert.equal(url.searchParams.get("campaign"), "fixture-campaign");
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get("accept"), "text/event-stream");
    assert.equal(headers.get("authorization"), `Bearer ${key}`);
    assert.equal(headers.get("x-tenant-slug"), "fixture-tenant");
    assert.equal(headers.get("x-test-client"), "offline");
    assert.equal(requestInit?.credentials, "include");
  });

  test("decodes multibyte UTF-8 when each byte arrives separately", async () => {
    const expected = { ...record, metadata: { label: "café 🫎" } };
    const bytes = encoder.encode(`data: ${JSON.stringify(expected)}\n\n`);
    const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
    assert.deepEqual(await collect(client(async () => response(chunks)).events.stream()), [expected]);
  });

  test("skips malformed records and comments while preserving later events", async () => {
    const sdk = client(async () => textResponse(
      ": fixture heartbeat\n\ndata: not-json\n\n",
      'data: {"event_type":"opened"}\n\n',
      `data: ${JSON.stringify({ ...record, metadata: [] })}\n\n`,
      `data: ${JSON.stringify(record)}\n\n`,
    ));
    assert.deepEqual(await collect(sdk.events.stream()), [record]);
  });

  test("retains the existing final-frame-at-EOF behavior", async () => {
    const sdk = client(async () => textResponse(`data: ${JSON.stringify(record)}\n`));
    assert.deepEqual(await collect(sdk.events.stream()), [record]);
  });

  test("maps HTTP errors and does not inherit automatic request retries", async () => {
    let calls = 0;
    const sdk = new PostwaveClient({ authMode: "none", retries: 4, fetch: async () => {
      calls++;
      return new Response('{"error":{"code":"missing_stream","message":"TEST-ONLY missing stream"}}', {
        status: 404,
        headers: { "content-type": "application/json", "x-request-id": "fixture-request" },
      });
    } });
    await assert.rejects(collect(sdk.events.stream()), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "missing_stream");
      assert.equal(error.requestId, "fixture-request");
      return true;
    });
    assert.equal(calls, 1);
  });

  test("breaking iteration cancels and unlocks the response body", async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`)); },
      cancel() { cancellations++; },
    });
    const sdk = client(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    for await (const item of sdk.events.stream()) {
      assert.deepEqual(item, record);
      break;
    }
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  });

  test("delivers multiple events from one transport chunk in order", async () => {
    const second = { ...record, event_type: "clicked" };
    const sdk = client(async () => textResponse(`data: ${JSON.stringify(record)}\n\ndata: ${JSON.stringify(second)}\n\n`));
    assert.deepEqual(await collect(sdk.events.stream()), [record, second]);
  });
});
