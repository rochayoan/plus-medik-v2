// Choose encrypted inbox transport while preserving the audited quote engine.
// Local mode uses ONLY a Docker persistent volume; Supabase remains unchanged.
import { InboxRepository, type InboxConfig } from "./inbox.js";
import { LocalInboxRepository } from "./local-inbox.js";

export type InboxStorage = Pick<InboxRepository, "ready" | "enqueue" | "claim" | "renew" | "finish">;

export function createInboxStorage(config: InboxConfig): InboxStorage {
  if (config.storage === "local") {
    if (!config.localDir) throw new Error("LOCAL_INBOX_DIRECTORY_REQUIRED");
    return new LocalInboxRepository(config.localDir, config.encryptionKey, true);
  }
  return new InboxRepository(config);
}
