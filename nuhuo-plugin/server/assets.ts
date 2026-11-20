import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assetSchema, type AssetFile, type WorkerRelease } from "../shared/catalog";
import { filesDigest, textDigest } from "./digest";
import { NuhuoPolicyError } from "./errors";
import { isMissingFile, writeFileAtomic } from "./files";

export type FetchAsset = (digest: string) => Promise<unknown>;
type SkillRef = WorkerRelease["skills"][number];

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

/** The instructions of a release, stored by digest so every release that shares them shares a file. */
export function instructionsPath(directory: string, digest: string): string {
  return path.join(directory, `${digest.replace("sha256:", "")}.md`);
}

/** Where a Skill version is unpacked. Agents read its files from here. */
export function skillPath(directory: string, skill: SkillRef): string {
  return path.join(directory, safeSegment(skill.name), safeSegment(skill.version));
}

export async function ensureInstructions(input: {
  directory: string;
  release: WorkerRelease;
  fetchAsset: FetchAsset;
}): Promise<void> {
  const { directory, release, fetchAsset } = input;
  const target = instructionsPath(directory, release.instructions.digest);
  if (await exists(target)) return;
  let content = release.instructions.content;
  if (content === undefined) {
    const asset = assetSchema.parse(await fetchAsset(release.instructions.digest));
    if (asset.kind !== "instructions" || asset.content === undefined) {
      throw new Error(`Asset ${release.instructions.digest} is not instructions`);
    }
    content = asset.content;
  }
  if (textDigest(content) !== release.instructions.digest) {
    throw new Error(`Instructions of Worker "${release.name}" do not match their digest`);
  }
  await writeFileAtomic(target, content);
}

/** Downloads a Skill once, checks it against its digest, and unpacks it. */
export async function ensureSkill(input: {
  directory: string;
  skill: SkillRef;
  fetchAsset: FetchAsset;
}): Promise<void> {
  const { directory, skill, fetchAsset } = input;
  const target = skillPath(directory, skill);
  if (await isSkillReady(directory, skill)) return;

  const asset = assetSchema.parse(await fetchAsset(skill.digest));
  if (asset.kind !== "skill" || asset.files === undefined) {
    throw new Error(`Asset ${skill.digest} is not a Skill`);
  }
  for (const file of asset.files) checkEntry(file);
  if (filesDigest(asset.files) !== skill.digest) {
    throw new Error(`Skill "${skill.name}" ${skill.version} does not match its digest`);
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(target)}.${randomBytes(6).toString("hex")}`);
  try {
    await unpack(staging, asset.files);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await writeFileAtomic(markerPath(target), skill.digest);
}

export async function isSkillReady(directory: string, skill: SkillRef): Promise<boolean> {
  const target = skillPath(directory, skill);
  const marker = await readOptional(markerPath(target));
  return marker === skill.digest && (await exists(target));
}

/** Reads a release's instructions at open. A missing file means the last pull failed to fetch it. */
export async function readInstructions(directory: string, release: WorkerRelease): Promise<string> {
  const content = await readOptional(instructionsPath(directory, release.instructions.digest));
  if (content === null) {
    throw new NuhuoPolicyError(
      `The instructions of Worker "${release.name}" have not reached this host. Press Import on the Nuhuo screen.`,
    );
  }
  return content;
}

function markerPath(target: string): string {
  return `${target}.digest`;
}

function safeSegment(value: string): string {
  if (!SEGMENT_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`"${value}" is not a safe directory name`);
  }
  return value;
}

/** Refuses absolute paths, `..`, and links that leave the Skill's directory. */
function checkEntry(file: AssetFile): void {
  const segments = file.relativePath.split("/");
  if (
    file.relativePath.includes("\\") ||
    file.relativePath.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Skill entry "${file.relativePath}" has an unsafe path`);
  }
  if (file.mode !== "symlink") return;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file.relativePath), file.linkTarget),
  );
  if (path.posix.isAbsolute(file.linkTarget) || resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`Skill link "${file.relativePath}" points outside the Skill`);
  }
}

async function unpack(root: string, files: readonly AssetFile[]): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(root, ...file.relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (file.mode === "symlink") {
      await symlink(file.linkTarget, target);
      continue;
    }
    await writeFile(target, Buffer.from(file.contentBase64, "base64"));
    await chmod(target, file.mode === "executable" ? 0o700 : 0o600);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
