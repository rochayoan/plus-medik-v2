import { randomUUID } from "node:crypto";
import {
  decryptPayload, restoreWebhookRequest,
  type InboxConfig, type InboxJob, type InboxRepository
} from "./inbox.js";

// The business handlers still use the audit ledger and sender's reservation
// fence. The queue is at-least-once, never an exactly-once message sender.
type ProcessRequest = (request: Request, schedule: (promise: Promise<unknown>) => void) => Promise<Response>;
type WorkerLog = (event: string, metadata?: Record<string, unknown>) => void;

export async function runInboxJob(
  repo: Pick<InboxRepository, "claim" | "renew" | "finish">,
  config: InboxConfig,
  owner: string,
  process: ProcessRequest,
  log: WorkerLog
): Promise<boolean> {
  const job: InboxJob | undefined = await repo.claim(owner);
  if (!job) return false;
  let lost = false;
  let renewalRunning = false;
  const heartbeat = setInterval(() => {
    if (renewalRunning || lost) return;
    renewalRunning = true;
    void repo.renew(job, owner).then(ok => { if (!ok) lost = true; })
      .catch(() => { lost = true; })
      .finally(() => { renewalRunning = false; });
  }, 60_000);
  heartbeat.unref();
  let success = false;
  try {
    const payload = decryptPayload(job.encrypted, config.encryptionKey);
    const request = restoreWebhookRequest(payload, config);
    const scheduled: Promise<unknown>[] = [];
    const response = await process(request, (task) => scheduled.push(task));
    const outcomes = await Promise.allSettled(scheduled);
    success = response.status === 200 && outcomes.every(x => x.status === "fulfilled");
    if (!success) log("inbox_job_not_completed", { status: response.status, failedTasks: outcomes.filter(x=>x.status==="rejected").length });
  } catch {
    log("inbox_job_exception");
  } finally {
    clearInterval(heartbeat);
  }
  if (lost) {
    log("inbox_lease_lost");
    return true;
  }
  try {
    const updated = await repo.finish(job, owner, success);
    if (!updated) log("inbox_finish_rejected");
    else log(success ? "inbox_job_completed" : "inbox_job_retry_scheduled");
  } catch {
    // The lease will expire and another worker can attempt this job.
    log("inbox_finish_unavailable");
  }
  return true;
}

export function startInboxWorker(
  repo: Pick<InboxRepository, "claim" | "renew" | "finish">,
  config: InboxConfig,
  process: ProcessRequest,
  log: WorkerLog = () => undefined
): { stop: () => void } {
  const owner = randomUUID();
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const worked = await runInboxJob(repo, config, owner, process, log);
      if (!stopped) timer = setTimeout(() => { void poll(); }, worked ? 25 : 2_000);
    } catch {
      log("inbox_claim_unavailable");
      if (!stopped) timer = setTimeout(() => { void poll(); }, 5_000);
    } finally { inFlight = false; }
  };
  timer = setTimeout(() => { void poll(); }, 0);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
