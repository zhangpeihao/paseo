import type { HostCredential } from "../shared/catalog";

const REQUEST_TIMEOUT_MS = 15_000;

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchFunction = (url: string, init: FetchInit) => Promise<FetchResponse>;

// React Native's global types redeclare `fetch` with their own `AbortSignal`; Node's fetch takes ours.
const nodeFetch = fetch as unknown as FetchFunction;

/** A failed call to Nuhuo. `status` is the HTTP status, absent for a network failure. */
export class NuhuoRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NuhuoRequestError";
  }
}

/** Calls the host API under `/api/paseo/v1/hosts/{hostId}` with the host's token. */
export class NuhuoClient {
  private readonly base: string;

  constructor(
    private readonly credential: HostCredential,
    private readonly fetchImpl: FetchFunction = nodeFetch,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    const center = credential.centerUrl.replace(/\/+$/, "");
    this.base = `${center}/api/paseo/v1/hosts/${encodeURIComponent(credential.hostId)}`;
  }

  getCatalog(): Promise<unknown> {
    return this.request("GET", "/catalog");
  }

  getSecrets(): Promise<unknown> {
    return this.request("GET", "/secrets");
  }

  getAsset(digest: string): Promise<unknown> {
    return this.request("GET", `/assets/${encodeURIComponent(digest)}`);
  }

  putInventory(inventory: unknown): Promise<unknown> {
    return this.request("PUT", "/inventory", inventory);
  }

  private async request(method: string, route: string, body?: unknown): Promise<unknown> {
    let response: FetchResponse;
    try {
      response = await this.fetchImpl(`${this.base}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.credential.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new NuhuoRequestError(
        `Nuhuo is unreachable at ${this.credential.centerUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new NuhuoRequestError(
        `Nuhuo answered ${method} ${route} with ${response.status}: ${readError(text)}`,
        response.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new NuhuoRequestError(`Nuhuo answered ${method} ${route} with a body that is not JSON`);
    }
  }
}

function readError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text.slice(0, 200) || "no details";
}
