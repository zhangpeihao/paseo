import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSkillReady } from "./assets";
import { CatalogStore } from "./catalog-store";
import { resolveNuhuoPaths, type NuhuoPaths } from "./paths";
import { NuhuoSync } from "./sync";
import {
  INSTRUCTIONS,
  INSTRUCTIONS_DIGEST,
  SKILL_DIGEST,
  SKILL_FILES,
  makeCatalog,
  makeRelease,
} from "./test-fixtures";

const TOKEN = "nuhuo_host_secret";

interface FakeCenter {
  url: string;
  secrets: Record<string, string>;
  skillFiles: unknown[];
  requests: string[];
}

describe("NuhuoSync", () => {
  let home: string;
  let paths: NuhuoPaths;
  let server: Server;
  let center: FakeCenter;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "nuhuo-sync-"));
    paths = resolveNuhuoPaths({ NUHUO_PASEO_HOME: home });
    center = {
      url: "",
      secrets: {
        "provider:nuhuo-claude:apiKey": "sk-ant-1",
        "github-token": "ghp_1",
        "tracker-token": "Bearer t",
      },
      skillFiles: SKILL_FILES,
      requests: [],
    };
    server = createServer((request, response) => serve(center, request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    center.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  async function writeCredential(token = TOKEN) {
    await writeFile(
      paths.credential,
      JSON.stringify({ centerUrl: center.url, hostId: "host_a", token }),
    );
  }

  function createSync() {
    const store = new CatalogStore(paths.catalog, () => new Date("2026-11-21T00:00:00Z"));
    return { store, sync: new NuhuoSync({ paths, store }) };
  }

  it("writes the catalog, private secret files, instructions, and verified Skills", async () => {
    await writeCredential();
    const { store, sync } = createSync();

    const status = await sync.pull();

    expect(status).toMatchObject({ lastError: null, problems: [], appliedToDaemon: false });
    expect((await store.read()).state).toBe("ready");
    expect(await readFile(path.join(paths.secrets, "github-token"), "utf8")).toBe("ghp_1");
    expect((await stat(path.join(paths.secrets, "github-token"))).mode & 0o777).toBe(0o600);
    expect((await stat(paths.secrets)).mode & 0o777).toBe(0o700);
    expect(
      await readFile(
        path.join(paths.instructions, `${INSTRUCTIONS_DIGEST.slice("sha256:".length)}.md`),
        "utf8",
      ),
    ).toBe(INSTRUCTIONS);

    const skill = path.join(paths.skills, "review", "1.0.0");
    expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toBe(
      "# Review\n\nRead the diff.\n",
    );
    expect((await stat(path.join(skill, "scripts", "run.sh"))).mode & 0o100).toBe(0o100);
    expect((await lstat(path.join(skill, "README.md"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(skill, "README.md"))).toBe("SKILL.md");
    expect(center.requests).toContain(`GET /assets/${SKILL_DIGEST}`);
  });

  it("refuses a Skill that does not match its digest and still applies the rest", async () => {
    await writeCredential();
    center.skillFiles = [{ relativePath: "SKILL.md", mode: "file", contentBase64: "dGFtcGVyZWQ=" }];
    const { store, sync } = createSync();

    const status = await sync.pull();

    expect(status.problems).toEqual([
      'Worker "Code reviewer": Skill "review" 1.0.0 does not match its digest',
    ]);
    expect((await store.read()).state).toBe("ready");
    expect(await isSkillReady(paths.skills, makeRelease().skills[0]!)).toBe(false);
  });

  it("refuses a Skill entry that escapes its directory", async () => {
    await writeCredential();
    center.skillFiles = [{ relativePath: "../evil.sh", mode: "file", contentBase64: "" }];
    const { sync } = createSync();

    const status = await sync.pull();

    expect(status.problems).toEqual([
      'Worker "Code reviewer": Skill entry "../evil.sh" has an unsafe path',
    ]);
  });

  it("removes secret files the catalog no longer names", async () => {
    await writeCredential();
    const { sync } = createSync();
    await sync.pull();

    delete center.secrets["github-token"];
    await sync.pull();

    await expect(stat(path.join(paths.secrets, "github-token"))).rejects.toThrow();
    expect(await readFile(path.join(paths.secrets, "tracker-token"), "utf8")).toBe("Bearer t");
  });

  it("keeps the last good catalog when Nuhuo refuses the token", async () => {
    await writeCredential();
    const { store, sync } = createSync();
    await sync.pull();
    await writeCredential("revoked");

    const status = await sync.pull();

    expect(status.lastError).toContain("with 401");
    expect((await store.read()).state).toBe("ready");
  });

  it("reports a host Nuhuo has not set up", async () => {
    const { sync } = createSync();

    const status = await sync.pull();

    expect(status.lastError).toContain("Nuhuo has not set up this host");
  });
});

function serve(center: FakeCenter, request: IncomingMessage, response: ServerResponse) {
  const route = (request.url ?? "").replace("/api/paseo/v1/hosts/host_a", "");
  center.requests.push(`${request.method} ${decodeURIComponent(route)}`);
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(response, 401, { error: "Unauthorized: Valid scoped host token required." });
  }
  if (route === "/catalog") return send(response, 200, makeCatalog());
  if (route === "/secrets") {
    return send(response, 200, { hostId: "host_a", catalogDigest: "x", secrets: center.secrets });
  }
  const digest = decodeURIComponent(route.replace("/assets/", ""));
  if (digest === SKILL_DIGEST) {
    return send(response, 200, {
      digest,
      kind: "skill",
      name: "review",
      version: "1.0.0",
      files: center.skillFiles,
    });
  }
  if (digest === INSTRUCTIONS_DIGEST) {
    return send(response, 200, {
      digest,
      kind: "instructions",
      name: "x.md",
      content: INSTRUCTIONS,
    });
  }
  return send(response, 404, { error: "Not found" });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
