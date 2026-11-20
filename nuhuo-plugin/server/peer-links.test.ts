import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { fingerprint } from "./digest";
import { reconcilePeers } from "./peer-links";
import { makeCatalog } from "./test-fixtures";

type PaseoApi = PluginHandlerContext["paseo"];

interface Saved {
  registrationId: string;
  serverId: string | null;
  sourceKey: string;
  metadata: Record<string, string>;
}

/** Records host registry calls; only `hosts.list`, `add`, `update`, and `remove` exist. */
function fakeRegistry(saved: Saved[]) {
  const calls: unknown[] = [];
  const paseo = {
    hosts: {
      list: async () => ({
        self: { serverId: "srv_a", label: "build-a" },
        hosts: saved.map((entry) => ({
          registrationId: entry.registrationId,
          serverId: entry.serverId,
          label: null,
          source: { id: "plugin", key: entry.sourceKey },
          metadata: entry.metadata,
          enabled: true,
          status: "online",
          targetDescription: "relay",
          lastOnlineAt: null,
          nextRetryAt: null,
          error: null,
        })),
      }),
      add: async (input: unknown) => {
        calls.push(["add", input]);
      },
      update: async (registrationId: string, patch: unknown) => {
        calls.push(["update", registrationId, patch]);
      },
      remove: async (registrationId: string) => {
        calls.push(["remove", registrationId]);
      },
    },
  } as unknown as PaseoApi;
  return { paseo, calls };
}

const PEER_METADATA = { "nuhuo.hostId": "host_b", "nuhuo.connection": fingerprint("offer-b") };

describe("reconcilePeers", () => {
  it("adds the employee's other hosts and skips this one", async () => {
    const { paseo, calls } = fakeRegistry([]);

    await reconcilePeers(paseo, makeCatalog());

    expect(calls).toEqual([
      [
        "add",
        {
          connection: "offer-b",
          label: "build-b",
          sourceKey: "nuhuo:host_b",
          metadata: PEER_METADATA,
        },
      ],
    ]);
  });

  it("leaves an unchanged link alone and the employee's own links untouched", async () => {
    const { paseo, calls } = fakeRegistry([
      {
        registrationId: "reg_b",
        serverId: "srv_b",
        sourceKey: "nuhuo:host_b",
        metadata: PEER_METADATA,
      },
      { registrationId: "reg_mine", serverId: "srv_x", sourceKey: "user:laptop", metadata: {} },
    ]);

    await reconcilePeers(paseo, makeCatalog());

    expect(calls).toEqual([]);
  });

  it("replaces the identity of a host set up again and removes hosts Nuhuo no longer lists", async () => {
    const { paseo, calls } = fakeRegistry([
      {
        registrationId: "reg_b",
        serverId: "srv_old",
        sourceKey: "nuhuo:host_b",
        metadata: PEER_METADATA,
      },
      {
        registrationId: "reg_c",
        serverId: "srv_c",
        sourceKey: "nuhuo:host_c",
        metadata: { "nuhuo.hostId": "host_c" },
      },
    ]);

    const changes = await reconcilePeers(paseo, makeCatalog());

    expect(calls).toEqual([
      [
        "update",
        "reg_b",
        { connection: "offer-b", metadata: PEER_METADATA, replaceIdentity: true },
      ],
      ["remove", "reg_c"],
    ]);
    expect(changes).toEqual({ added: [], updated: ["host_b"], removed: ["host_c"] });
  });
});
