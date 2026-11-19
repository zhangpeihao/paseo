import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const workerSummarySchema = z.object({
  workerId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  displayVersion: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

export const hostStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    bundlePath: z.string(),
    centerId: z.string(),
    hostId: z.string(),
    employee: z.object({ id: z.string(), displayName: z.string() }),
    issuedAt: z.string(),
    expiresAt: z.string().optional(),
    requireWorker: z.boolean(),
    defaultWorkerId: z.string().optional(),
    workers: z.array(workerSummarySchema),
  }),
  z.object({
    state: z.enum(["missing", "invalid", "expired"]),
    bundlePath: z.string(),
    message: z.string(),
    detail: z.string().optional(),
  }),
]);

export type WorkerSummary = z.infer<typeof workerSummarySchema>;
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const statusRpc = defineRpc({
  name: "nuhuo.status.get",
  input: z.object({}),
  output: hostStatusSchema,
});
