import {
  hostCatalogSchema,
  type AssetFile,
  type HostCatalog,
  type WorkerRelease,
} from "../shared/catalog";

// Digests below were computed by Nuhuo's `scanAndDigestDirectory` and `computeTextDigest`, so the
// tests check the plugin against Nuhuo rather than against itself.

export const SKILL_FILES: AssetFile[] = [
  { relativePath: "README.md", mode: "symlink", linkTarget: "SKILL.md" },
  { relativePath: "scripts/run.sh", mode: "executable", contentBase64: "IyEvYmluL3NoCmVjaG8gb2sK" },
  { relativePath: "SKILL.md", mode: "file", contentBase64: "IyBSZXZpZXcKClJlYWQgdGhlIGRpZmYuCg==" },
];
export const SKILL_DIGEST =
  "sha256:7d32810fe2f0b1a4ee97600c73fa262ac65b6e80f87090f0845bfb5d78dc39ad";

export const INSTRUCTIONS = "# Reviewer\r\nReview carefully.\n";
export const INSTRUCTIONS_DIGEST =
  "sha256:61b21a2f1527172f8ee7fd285cf164d294b834febf14ea6de588e576717597d5";

const RELEASE_DIGEST = `sha256:${"a".repeat(64)}`;
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}`;

export function makeRelease(overrides: Partial<WorkerRelease> = {}): WorkerRelease {
  return {
    schema: 1,
    workerId: "reviewer",
    name: "Code reviewer",
    digest: RELEASE_DIGEST,
    ownerId: "emp_1",
    hostId: "host_a",
    role: { id: "reviewer-role", version: "1.0.0", digest: "sha256:role" },
    providerId: "nuhuo-claude",
    launch: {
      providerKind: "claude",
      model: "claude-sonnet-4-5",
      modeId: "default",
      thinkingOptionId: "high",
      unattended: false,
      cwd: "/srv/app",
      env: { REVIEW_DEPTH: "full" },
      secretEnv: { GITHUB_TOKEN: { secretRef: "github-token" } },
      allowedOverrides: { model: false, modeId: true, thinkingOptionId: false, cwd: true },
    },
    instructions: { digest: INSTRUCTIONS_DIGEST },
    skills: [{ name: "review", version: "1.0.0", digest: SKILL_DIGEST }],
    tools: [],
    mcpServers: {
      tracker: {
        type: "http",
        url: "https://tracker.example.com/mcp",
        headers: { Authorization: { secretRef: "tracker-token" }, "X-Team": "core" },
      },
    },
    publishedAt: "2026-11-20T10:00:00.000Z",
    ...overrides,
  };
}

export function makeCatalog(overrides: Record<string, unknown> = {}): HostCatalog {
  return hostCatalogSchema.parse({
    schema: 1,
    hostId: "host_a",
    ownerId: "emp_1",
    digest: CATALOG_DIGEST,
    issuedAt: "2026-11-20T10:00:00.000Z",
    expiresAt: "2026-11-27T10:00:00.000Z",
    policy: { requireWorker: false },
    providers: [
      {
        id: "nuhuo-claude",
        label: "My Claude",
        kind: "claude",
        env: { ANTHROPIC_API_KEY: { secretRef: "provider:nuhuo-claude:apiKey" } },
        models: [],
      },
    ],
    workers: [makeRelease()],
    hosts: [
      { hostId: "host_a", name: "build-a", serverId: "srv_a", connection: "offer-a" },
      { hostId: "host_b", name: "build-b", serverId: "srv_b", connection: "offer-b" },
    ],
    peerWorkers: [
      {
        workerId: "writer",
        name: "Docs writer",
        hostId: "host_b",
        roleId: "writer-role",
        providerId: "nuhuo-codex",
        model: "gpt-5",
        cwd: "/srv/docs",
      },
    ],
    ...overrides,
  });
}
