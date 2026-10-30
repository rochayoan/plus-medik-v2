// Disk-backed encrypted Kapso inbox for Dokploy single-replica deployment.
// No database schema changes. Requires a persistent, writable, private volume.
// ACK is issued by the router only after the fsynced encrypted record exists.
// Deliberately single-writer/single-worker: never scale this mode to >1 replica.
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeFileSync, renameSync
} from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import { join } from "node:path";
import { encryptPayload, type EncryptedEnvelope, type InboxJob, type QueuedRequest } from "./inbox.js";

type Status = "pending" | "leased" | "completed" | "dead";
interface StoredJob {
  version: 1;
  id: string;
  status: Status;
  attempts: number;
  generation: number;
  owner: string | null;
  leaseUntil: number | null;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  encrypted?: EncryptedEnvelope;
}
const MAX_JOBS = 10000;
const MAX_ATTEMPTS = 7;
const LEASE_MS = 300000;
const ID_PATTERN = /^[0-9a-f]{64}$/;

export class LocalInboxRepository {
  constructor(
    private readonly directory: string,
    private readonly encryptionKey: Buffer,
    private readonly requireMountedVolume = false
  ) {}

  private ensureDirectory(): void {
    // A missing or unwritable volume must not lead to an ACK.
    if (this.requireMountedVolume) {
      // Docker requires an actual volume mount at /data or at the spool folder.
      // A directory inside the ephemeral container is NOT equivalent.
      const mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
      const mounts = mountInfo.split("\n").map(line => line.split(" - ")[0]?.split(" ")[4])
        .filter((part): part is string => typeof part === "string");
      if (!mounts.includes("/data") && !mounts.includes(this.directory)) {
        throw new Error("LOCAL_INBOX_VOLUME_NOT_MOUNTED");
      }
    }
    if (!this.directory.startsWith("/") || this.directory === "/" || this.directory.startsWith("/app/")) {
      throw new Error("LOCAL_INBOX_PATH_INVALID");
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!statSync(this.directory).isDirectory()) throw new Error("LOCAL_INBOX_NOT_DIRECTORY");
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private file(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error("LOCAL_INBOX_BAD_ID");
    return join(this.directory, id + ".json");
  }

  private listIds(): string[] {
    return readdirSync(this.directory)
      .filter(name => /^[0-9a-f]{64}\.json$/.test(name))
      .map(name => name.slice(0, -5));
  }

  private read(id: string): StoredJob {
    const record: unknown = JSON.parse(readFileSync(this.file(id), "utf8"));
    if (!record || typeof record !== "object") throw new Error("LOCAL_INBOX_CORRUPT");
    const job = record as StoredJob;
    if (job.version !== 1 || job.id !== id || !["pending","leased","completed","dead"].includes(job.status)
        || !Number.isInteger(job.attempts) || job.attempts < 0 || job.attempts > MAX_ATTEMPTS
        || !Number.isInteger(job.generation) || job.generation < 0
        || !Number.isFinite(job.availableAt) || !Number.isFinite(job.createdAt)
        || !Number.isFinite(job.updatedAt) || (job.status !== "completed" && !job.encrypted)) {
      throw new Error("LOCAL_INBOX_CORRUPT");
    }
    return job;
  }

  private write(job: StoredJob): void {
    const tmp = join(this.directory, "." + job.id + "." + randomUUID() + ".tmp");
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(job), "utf8");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(tmp, this.file(job.id));
      this.syncDirectory();
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(tmp); } catch { /* temp already renamed or removed */ }
      throw error;
    }
  }

  async ready(): Promise<boolean> {
    try {
      this.ensureDirectory();
      // A write+fsync probe tests actual storage rather than merely its existence.
      const id = randomUUID();
      const path = join(this.directory, "." + id + ".probe");
      let fd: number | undefined;
      try {
        fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, "probe");
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        unlinkSync(path);
        this.syncDirectory();
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(path); } catch { /* already cleaned */ }
      }
      return true;
    } catch { return false; }
  }

  async enqueue(value: QueuedRequest): Promise<void> {
    this.ensureDirectory();
    // HMAC digest reveals neither phone number nor event body on disk.
    const id = createHmac("sha256", this.encryptionKey).update("inbox-id-v1\0").update(value.rawBody).digest("hex");
    if (existsSync(this.file(id))) {
      this.read(id); // Fail rather than ACK on a corrupt duplicate.
      this.syncDirectory();
      return;
    }
    if (this.listIds().length >= MAX_JOBS) throw new Error("LOCAL_INBOX_CAPACITY_EXCEEDED");
    const now = Date.now();
    this.write({
      version: 1, id, status: "pending", attempts: 0, generation: 0,
      owner: null, leaseUntil: null, availableAt: now, createdAt: now, updatedAt: now,
      encrypted: encryptPayload(value, this.encryptionKey)
    });
  }

  async claim(owner: string): Promise<InboxJob | undefined> {
    this.ensureDirectory();
    // Process in arrival order. Expired leases are reclaimable after a restart.
    const candidates = this.listIds().map(id => this.read(id))
      .filter(job => job.status === "pending" || job.status === "leased")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const now = Date.now();
    for (const job of candidates) {
      if (job.status === "leased" && (job.leaseUntil ?? Infinity) > now) continue;
      if (job.attempts >= MAX_ATTEMPTS) {
        job.status = "dead"; job.owner = null; job.leaseUntil = null; job.updatedAt = now;
        this.write(job);
        continue;
      }
      if (job.status === "pending" && job.availableAt > now) continue;
      job.status = "leased";
      job.owner = owner;
      job.leaseUntil = now + LEASE_MS;
      job.attempts += 1;
      job.generation += 1;
      job.updatedAt = now;
      this.write(job);
      return { id: job.id, generation: job.generation, encrypted: job.encrypted! };
    }
    return undefined;
  }

  private getActive(job: InboxJob, owner: string): StoredJob | undefined {
    if (!existsSync(this.file(job.id))) return undefined;
    const record = this.read(job.id);
    return record.status === "leased" && record.owner === owner
      && record.generation === job.generation && (record.leaseUntil ?? 0) > Date.now()
      ? record : undefined;
  }

  async renew(job: InboxJob, owner: string): Promise<boolean> {
    const record = this.getActive(job, owner);
    if (!record) return false;
    record.leaseUntil = Date.now() + LEASE_MS;
    record.updatedAt = Date.now();
    this.write(record);
    return true;
  }

  async finish(job: InboxJob, owner: string, ok: boolean): Promise<boolean> {
    const record = this.getActive(job, owner);
    if (!record) return false;
    record.status = ok ? "completed" : record.attempts >= MAX_ATTEMPTS ? "dead" : "pending";
    record.availableAt = ok ? record.availableAt : Date.now() + Math.min(300000, 5000 * 2 ** Math.min(record.attempts, 6));
    record.owner = null;
    record.leaseUntil = null;
    record.updatedAt = Date.now();
    if (ok) delete record.encrypted; // Never retain successful patient content.
    this.write(record);
    return true;
  }
}
