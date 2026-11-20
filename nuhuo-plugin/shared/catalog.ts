import { z } from "zod";

/** Agent metadata key a composer or caller sets to choose a Worker before creation. */
export const WORKER_CHOICE_KEY = "nuhuo.worker";
/** Agent metadata key the create hook writes to record which release an agent was created from. */
export const BINDING_KEY = "nuhuo.binding";
/** Every provider profile the plugin manages starts with this; it never touches the others. */
export const PROVIDER_PREFIX = "nuhuo-";
/** Source key prefix of the saved hosts the plugin manages. */
export const PEER_SOURCE_PREFIX = "nuhuo:";

export const PROVIDER_KINDS = ["claude", "codex", "opencode", "pi"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const nonEmpty = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });

/** Written by Nuhuo's setup to `host.json`; the token reads only this host's data. */
export const credentialSchema = z.object({
  centerUrl: z.url(),
  hostId: nonEmpty,
  token: nonEmpty,
});
export type HostCredential = z.infer<typeof credentialSchema>;

const secretRefSchema = z.object({ secretRef: nonEmpty });
export type SecretRef = z.infer<typeof secretRefSchema>;
const valueOrSecret = z.union([z.string(), secretRefSchema]);
export type ValueOrSecret = z.infer<typeof valueOrSecret>;

const stdioServerSchema = z.object({
  type: z.literal("stdio"),
  command: nonEmpty,
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), valueOrSecret).optional(),
});

const remoteServerSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.url(),
  headers: z.record(z.string(), valueOrSecret).optional(),
});

export const mcpServerSchema = z.discriminatedUnion("type", [
  stdioServerSchema,
  remoteServerSchema,
]);
export type McpServerTemplate = z.infer<typeof mcpServerSchema>;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected a sha256 digest");

export const workerReleaseSchema = z.object({
  schema: z.literal(1),
  workerId: nonEmpty,
  name: nonEmpty,
  digest: digestSchema,
  ownerId: nonEmpty,
  hostId: nonEmpty,
  role: z.object({ id: nonEmpty, version: nonEmpty, digest: nonEmpty }),
  providerId: nonEmpty.startsWith(PROVIDER_PREFIX),
  launch: z.object({
    providerKind: z.enum(PROVIDER_KINDS),
    model: z.string(),
    modeId: nonEmpty,
    thinkingOptionId: nonEmpty.optional(),
    unattended: z.boolean(),
    cwd: nonEmpty.optional(),
    env: z.record(z.string(), z.string()),
    secretEnv: z.record(z.string(), secretRefSchema),
    allowedOverrides: z.object({
      model: z.boolean(),
      modeId: z.boolean(),
      thinkingOptionId: z.boolean(),
      cwd: z.boolean(),
    }),
  }),
  instructions: z.object({ digest: digestSchema, content: z.string().optional() }),
  skills: z.array(
    z.object({
      name: nonEmpty,
      version: nonEmpty,
      digest: digestSchema,
      targetSubdir: z.string().optional(),
    }),
  ),
  tools: z.array(
    z.object({
      name: nonEmpty,
      version: nonEmpty,
      digest: digestSchema,
      entryPoint: z.string(),
      supportedPlatforms: z.array(z.string()),
    }),
  ),
  mcpServers: z.record(z.string(), mcpServerSchema),
  publishedAt: timestamp,
});
export type WorkerRelease = z.infer<typeof workerReleaseSchema>;

export const catalogProviderSchema = z.object({
  id: nonEmpty.startsWith(PROVIDER_PREFIX),
  label: nonEmpty,
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z.url().optional(),
  env: z.record(z.string(), secretRefSchema),
  models: z.array(nonEmpty),
});
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;

/** One of the employee's hosts. `connection` is its relay pairing offer, a bearer credential. */
export const employeeHostSchema = z.object({
  hostId: nonEmpty,
  name: nonEmpty,
  serverId: nonEmpty,
  connection: nonEmpty,
});
export type EmployeeHost = z.infer<typeof employeeHostSchema>;

/** A Worker on another of the employee's hosts: enough to list it and start it there. */
export const peerWorkerSchema = z.object({
  workerId: nonEmpty,
  name: nonEmpty,
  hostId: nonEmpty,
  roleId: nonEmpty,
  providerId: nonEmpty,
  model: z.string(),
  cwd: nonEmpty.optional(),
});
export type PeerWorker = z.infer<typeof peerWorkerSchema>;

export const hostCatalogSchema = z
  .object({
    schema: z.literal(1),
    hostId: nonEmpty,
    ownerId: nonEmpty,
    digest: digestSchema,
    issuedAt: timestamp,
    expiresAt: timestamp,
    policy: z.object({ requireWorker: z.boolean() }),
    defaultWorkerId: nonEmpty.optional(),
    providers: z.array(catalogProviderSchema),
    /** This host's Workers, with their releases. */
    workers: z.array(workerReleaseSchema),
    /** Every ready host of the employee, this one included. Older Centers omit it. */
    hosts: z.array(employeeHostSchema).default([]),
    /** The employee's Workers on their other hosts. Older Centers omit it. */
    peerWorkers: z.array(peerWorkerSchema).default([]),
  })
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    for (const [index, worker] of catalog.workers.entries()) {
      if (seen.has(worker.workerId)) {
        context.addIssue({
          code: "custom",
          path: ["workers", index, "workerId"],
          message: `Worker "${worker.workerId}" appears more than once`,
        });
      }
      if (worker.hostId !== catalog.hostId) {
        context.addIssue({
          code: "custom",
          path: ["workers", index, "hostId"],
          message: `Worker "${worker.workerId}" belongs to host "${worker.hostId}"`,
        });
      }
      seen.add(worker.workerId);
    }
    if (catalog.defaultWorkerId !== undefined && !seen.has(catalog.defaultWorkerId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultWorkerId"],
        message: `Default Worker "${catalog.defaultWorkerId}" is not on this host`,
      });
    }
  });
export type HostCatalog = z.infer<typeof hostCatalogSchema>;

export const secretsResponseSchema = z.object({
  hostId: nonEmpty,
  catalogDigest: z.string(),
  secrets: z.record(z.string(), z.string()),
});

const assetFileSchema = z.discriminatedUnion("mode", [
  z.object({
    relativePath: nonEmpty,
    mode: z.enum(["file", "executable"]),
    contentBase64: z.string(),
  }),
  z.object({ relativePath: nonEmpty, mode: z.literal("symlink"), linkTarget: nonEmpty }),
]);
export type AssetFile = z.infer<typeof assetFileSchema>;

export const assetSchema = z.object({
  digest: digestSchema,
  kind: z.enum(["instructions", "skill", "tool"]),
  name: nonEmpty,
  version: z.string().optional(),
  content: z.string().optional(),
  files: z.array(assetFileSchema).optional(),
});
export type Asset = z.infer<typeof assetSchema>;

export const bindingSchema = z.object({
  workerId: nonEmpty,
  workerName: nonEmpty,
  releaseDigest: nonEmpty,
});
export type WorkerBinding = z.infer<typeof bindingSchema>;
