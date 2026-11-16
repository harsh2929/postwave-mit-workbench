import { Resource } from "./_base.js";
import {
  normalizePollInterval,
  normalizeWaitTimeout,
  pollUntilTerminal,
} from "../lib/polling.js";
import type { RegisterVoiceSource, VoiceProfile, VoiceSource } from "../types.js";

/**
 * IngestJob is the polling shape for /sources/{source_id}/ingest.
 * Identical state machine to SequenceJob.
 */
export interface IngestJob {
  id: string;
  tenant_id: string;
  source_id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  item_count: number;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface IngestWaitOptions {
  /** Delay between polls in ms. Default 2000, capped at 30000. */
  intervalMs?: number;
  /**
   * Overall wait deadline in ms. Default 5 minutes, capped at 30 minutes.
   * It bounds the whole wait, including an in-flight poll request and its
   * body read. Expiry rejects with `TimeoutError` (`scope: "wait"`).
   */
  timeoutMs?: number;
  /**
   * Cancel the wait at any point, including mid-poll. Rejects with
   * `RequestAbortedError`; an already-aborted signal sends no request.
   */
  signal?: AbortSignal;
}

export class VoiceProfileResource extends Resource {
  get(): Promise<VoiceProfile> {
    return this.client.request("GET", "/api/v1/voice/profile");
  }

  /** Re-build the profile from currently-ingested sources. */
  build(): Promise<VoiceProfile> {
    return this.client.request("POST", "/api/v1/voice/profile/build");
  }

  listSources(): Promise<VoiceSource[]> {
    return this.client.request("GET", "/api/v1/voice/sources");
  }

  addSource(input: RegisterVoiceSource): Promise<{ source_id: string }> {
    return this.client.request("POST", "/api/v1/voice/sources", { body: input });
  }

  /**
   * Kick off ingestion. Returns `{job_id}`; poll `getIngestJob(id)`
   * until terminal status. Job rows are tenant-scoped + RLS-isolated.
   */
  ingestSource(sourceID: string): Promise<{ job_id: string; status?: string }> {
    return this.client.request(
      "POST",
      `/api/v1/voice/sources/${encodeURIComponent(sourceID)}/ingest`,
    );
  }

  /** Poll an ingest job started by `ingestSource(sourceID)`. */
  getIngestJob(
    sourceID: string,
    jobID: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<IngestJob> {
    return this.client.request(
      "GET",
      `/api/v1/voice/sources/${encodeURIComponent(sourceID)}/ingest/${encodeURIComponent(jobID)}`,
      { signal: opts.signal },
    );
  }

  /**
   * Convenience: poll until terminal. Constant 2s backoff, 5 min
   * timeout. Same shape and lifecycle guarantees as
   * SequencesResource.waitForJob: the deadline and `signal` bound an
   * in-flight poll, expiry rejects with `TimeoutError` (`scope: "wait"`),
   * and cancellation rejects with `RequestAbortedError`.
   */
  waitForIngestJob(
    sourceID: string,
    jobID: string,
    opts: IngestWaitOptions = {},
  ): Promise<IngestJob> {
    return pollUntilTerminal({
      label: `voice.waitForIngestJob(${jobID})`,
      intervalMs: normalizePollInterval(opts.intervalMs),
      timeoutMs: normalizeWaitTimeout(opts.timeoutMs),
      signal: opts.signal,
      poll: (signal) => this.getIngestJob(sourceID, jobID, { signal }),
      isTerminal: (job) => job.status === "succeeded" || job.status === "failed",
    });
  }

  removeSource(id: string): Promise<void> {
    return this.client.request("DELETE", `/api/v1/voice/sources/${encodeURIComponent(id)}`);
  }
}
