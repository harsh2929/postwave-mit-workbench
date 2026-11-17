// SPDX-License-Identifier: MIT
// Mock-only regressions for the previously fixed streaming defects.
// --check exits nonzero if a regression returns; separate from the offline suites.
import assert from "node:assert/strict";
import { PostwaveClient, RequestAbortedError, NotFoundError } from "../src/index.ts";

const encoder = new TextEncoder();
const record = { ts: "2026-11-16T00:00:00Z", event_type: "opened" };
const results = [];
const client = (fetch) => new PostwaveClient({ authMode: "none", retries: 0, fetch });

function response(chunks) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

async function observe(promise, ms = 300) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ state: "resolved", value }), error => ({ state: "rejected", error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: "pending" }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

await check("multiline data survives CRLF split between transport chunks", async () => {
  const sdk = client(async () => response([
    'data: {"ts":"2026-11-16T00:00:00Z","event_type":\r',
    '\ndata: "opened"}\r', '\n\r', '\n',
  ]));
  assert.deepEqual(await collect(sdk.events.stream()), [record]);
});

await check("overflow discards the whole frame, not just its first chunk", async () => {
  const sdk = client(async () => response([
    "data: " + "x".repeat(300_000),
    `\ndata: ${JSON.stringify(record)}\n\n`,
  ]));
  assert.deepEqual(await collect(sdk.events.stream()), []);
});

await check("pre-aborted signals reject without calling the transport", async () => {
  const controller = new AbortController();
  controller.abort("TEST-ONLY cancellation");
  let calls = 0;
  const sdk = client(async () => { calls++; return response([]); });
  const result = await observe(collect(sdk.events.stream({ signal: controller.signal })));
  assert.equal(calls, 0, "pre-aborted stream must not call fetch");
  assert.equal(result.state, "rejected");
  assert.ok(result.error instanceof RequestAbortedError);
});

await check("caller cancellation interrupts an uncooperative body read", async () => {
  const controller = new AbortController();
  let source;
  let cancellations = 0;
  const body = new ReadableStream({
    start(c) { source = c; },
    cancel() { cancellations++; },
  });
  const sdk = client(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const operation = collect(sdk.events.stream({ signal: controller.signal }));
  let result;
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort("TEST-ONLY cancellation");
    result = await observe(operation);
    assert.equal(result.state, "rejected", "stream is still pending after caller cancellation");
    assert.ok(result.error instanceof RequestAbortedError);
    assert.ok(cancellations > 0, "cancel the abandoned response body");
    assert.equal(body.locked, false, "release the response reader");
  } finally {
    // Close the fixture so a regressed implementation can finish without hanging.
    try { source.close(); } catch { /* already cancelled */ }
    await observe(operation);
  }
});

await check("mapped HTTP failures release their response reader", async () => {
  const body = new ReadableStream({ start(c) {
    c.enqueue(encoder.encode('{"error":{"code":"missing_stream","message":"TEST-ONLY missing stream"}}'));
    c.close();
  } });
  const sdk = client(async () => new Response(body, { status: 404, headers: { "content-type": "application/json" } }));
  const result = await observe(collect(sdk.events.stream()));
  assert.equal(result.state, "rejected");
  assert.ok(result.error instanceof NotFoundError);
  assert.equal(body.locked, false, "HTTP error body reader remains locked");
});

const failed = results.filter(result => !result.passed).length;
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed, unresolved: failed, results }, null, 2));
if (process.argv.includes("--check") && failed) process.exitCode = 1;
