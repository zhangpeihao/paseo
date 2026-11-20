import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { PROVIDER_KINDS } from "./catalog";

export const syncStatusSchema = z.object({
  pulling: z.boolean(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Parts of the last pull that failed while the rest applied. */
  problems: z.array(z.string()),
  /** Whether the last pull reached the daemon: providers, host links, and the inventory report. */
  appliedToDaemon: z.boolean(),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const workerSummarySchema = z.object({
  workerId: z.string(),
  name: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  onThisHost: z.boolean(),
  roleId: z.string(),
  providerId: z.string(),
  model: z.string(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export type WorkerSummary = z.infer<typeof workerSummarySchema>;

export const hostLinkSchema = z.enum([
  "this-host",
  "online",
  "connecting",
  "offline",
  "error",
  "disabled",
  "not-linked",
]);
export type HostLink = z.infer<typeof hostLinkSchema>;

export const hostSummarySchema = z.object({
  hostId: z.string(),
  name: z.string(),
  link: hostLinkSchema,
});
export type HostSummary = z.infer<typeof hostSummarySchema>;

export const providerSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  models: z.array(z.string()),
});

export const hostStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    hostId: z.string(),
    requireWorker: z.boolean(),
    defaultWorkerId: z.string().optional(),
    issuedAt: z.string(),
    expiresAt: z.string(),
    providers: z.array(providerSummarySchema),
    hosts: z.array(hostSummarySchema),
    workers: z.array(workerSummarySchema),
    sync: syncStatusSchema,
  }),
  z.object({
    state: z.enum(["missing", "invalid", "expired"]),
    message: z.string(),
    detail: z.string().optional(),
    sync: syncStatusSchema,
  }),
]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const statusRpc = defineRpc({
  name: "nuhuo.status.get",
  input: z.object({}),
  output: hostStatusSchema,
});

/** Pulls from Nuhuo now and returns the status after the pull. */
export const importRpc = defineRpc({
  name: "nuhuo.catalog.import",
  input: z.object({}),
  output: hostStatusSchema,
});

/** Starts an idle agent for a Worker on its host. */
export const startWorkerRpc = defineRpc({
  name: "nuhuo.workers.start",
  input: z.object({ workerId: z.string().min(1) }),
  output: z.object({ serverId: z.string(), agentId: z.string() }),
});
