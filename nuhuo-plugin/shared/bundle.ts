import { z } from "zod";

/** Agent metadata key a composer sets to choose a Worker before creation. */
export const WORKER_CHOICE_KEY = "nuhuo.worker";
/** Agent metadata key the create hook writes to record which release an agent was created from. */
export const BINDING_KEY = "nuhuo.binding";

const nonEmpty = z.string().trim().min(1);

/** A file name inside the host's secrets directory. Nuhuo writes the file; the plugin reads it at open. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const secretRef = z.object({
  secretRef: z
    .string()
    .regex(SECRET_NAME_PATTERN, "A secretRef is a file name without path separators"),
});

const secretMap = z.record(z.string(), secretRef);

const stdioServer = z.object({
  type: z.literal("stdio"),
  command: nonEmpty,
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  secretEnv: secretMap.optional(),
  alwaysLoad: z.boolean().optional(),
});

const remoteServer = z.object({
  type: z.enum(["http", "sse"]),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  secretHeaders: secretMap.optional(),
  alwaysLoad: z.boolean().optional(),
});

export const mcpServerTemplateSchema = z.discriminatedUnion("type", [stdioServer, remoteServer]);

export const workerReleaseSchema = z.object({
  workerId: nonEmpty,
  name: nonEmpty,
  description: z.string().optional(),
  releaseDigest: nonEmpty,
  displayVersion: nonEmpty,
  provider: nonEmpty,
  model: nonEmpty.optional(),
  modeId: nonEmpty.optional(),
  thinkingOptionId: nonEmpty.optional(),
  allowedOverrides: z.array(z.enum(["model", "modeId", "thinkingOptionId"])).default([]),
  instructions: z.string(),
  mcpServers: z.record(z.string(), mcpServerTemplateSchema).default({}),
  env: z.record(z.string(), z.string()).default({}),
  secretEnv: secretMap.default({}),
});

export const hostBundleSchema = z
  .object({
    schema: z.literal(1),
    centerId: nonEmpty,
    hostId: nonEmpty,
    employee: z.object({ id: nonEmpty, displayName: nonEmpty }),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    requireWorker: z.boolean(),
    defaultWorkerId: nonEmpty.optional(),
    workers: z.array(workerReleaseSchema),
  })
  .superRefine((bundle, context) => {
    const seen = new Set<string>();
    for (const [index, worker] of bundle.workers.entries()) {
      if (seen.has(worker.workerId)) {
        context.addIssue({
          code: "custom",
          path: ["workers", index, "workerId"],
          message: `Worker "${worker.workerId}" appears more than once`,
        });
      }
      seen.add(worker.workerId);
    }
    if (bundle.defaultWorkerId !== undefined && !seen.has(bundle.defaultWorkerId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultWorkerId"],
        message: `Default Worker "${bundle.defaultWorkerId}" is not in workers`,
      });
    }
  });

export type McpServerTemplate = z.infer<typeof mcpServerTemplateSchema>;
export type WorkerRelease = z.infer<typeof workerReleaseSchema>;
export type HostBundle = z.infer<typeof hostBundleSchema>;

export const bindingSchema = z.object({
  centerId: nonEmpty,
  workerId: nonEmpty,
  workerName: nonEmpty,
  releaseDigest: nonEmpty,
});

export type WorkerBinding = z.infer<typeof bindingSchema>;
