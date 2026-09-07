import { lookup as dnsLookup, type LookupAddress } from "dns";
import { isIP } from "net";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "http";
import { request as httpsRequest } from "https";

/**
 * An address the server refuses to open a connection to.
 *
 * `/__fetch-doc` fetches a URL the caller supplies and hands the body back, so
 * without this it is an open proxy into everything the machine can reach that
 * the caller cannot: other loopback services, the cloud instance metadata
 * endpoint on 169.254.169.254, and anything on the local network.
 */
function blockedReason(address: string, family: number): string | null {
  if (family === 6) {
    const ip = address.toLowerCase().split("%")[0];
    // An IPv4-mapped address is an IPv4 address wearing a different hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return blockedReason(mapped[1], 4);
    if (ip === "::1") return "loopback";
    if (ip === "::") return "unspecified";
    const head = parseInt(ip.split(":")[0] || "0", 16);
    if ((head & 0xfe00) === 0xfc00) return "unique-local";
    if ((head & 0xffc0) === 0xfe80) return "link-local";
    if ((head & 0xff00) === 0xff00) return "multicast";
    return null;
  }

  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return "unparseable";
  }
  const [a, b] = octets;
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
  if (a >= 224) return "multicast or reserved";
  return null;
}

export class BlockedAddressError extends Error {}

/**
 * A dns.lookup replacement that fails the connection when the name resolves
 * somewhere private.
 *
 * The check has to sit here rather than in front of the request: resolving the
 * name separately and then calling fetch() leaves a window in which the record
 * can change between the two, and the connection is then made to an address
 * that was never checked. This runs at connect time, on the addresses the
 * socket is actually about to use.
 */
function guardedLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
): void {
  (dnsLookup as any)(hostname, { ...(options as object), all: true }, (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[]
  ) => {
    if (err) return callback(err, undefined);
    if (!addresses || addresses.length === 0) {
      return callback(new BlockedAddressError(`'${hostname}' did not resolve`), undefined);
    }
    for (const entry of addresses) {
      const reason = blockedReason(entry.address, entry.family);
      if (reason) {
        return callback(
          new BlockedAddressError(`'${hostname}' resolves to a ${reason} address (${entry.address})`),
          undefined
        );
      }
    }
    const wantsAll = (options as { all?: boolean } | undefined)?.all === true;
    if (wantsAll) return callback(null, addresses as any);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  url: URL;
  truncated: boolean;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

/**
 * Fetches a public http(s) document.
 *
 * Redirects are followed by hand rather than by the client, so every hop is
 * checked instead of only the URL the caller passed — a public URL that 302s
 * to 169.254.169.254 is the ordinary way past a check that only looks at the
 * first request.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  let target = new URL(raw);

  for (let hop = 0; ; hop++) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new BlockedAddressError("url must be http or https");
    }

    const response = await requestOnce(target, options);
    const location = response.headers.location;
    const isRedirect =
      typeof response.statusCode === "number" &&
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      typeof location === "string";

    if (!isRedirect) {
      const { body, truncated } = await readCapped(response, options.maxBytes);
      return {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body,
        url: target,
        truncated,
      };
    }

    response.resume();
    if (hop >= maxRedirects) throw new BlockedAddressError("too many redirects");
    target = new URL(location, target);
  }
}

function requestOnce(target: URL, options: SafeFetchOptions): Promise<IncomingMessage> {
  // A hostname that is already an IP literal never reaches the lookup hook —
  // Node connects straight to it — so it is checked here instead.
  const literal = target.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(literal);
  if (family) {
    const reason = blockedReason(literal, family);
    if (reason) {
      throw new BlockedAddressError(`${literal} is a ${reason} address`);
    }
  }

  const secure = target.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;
  const requestOptions: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    headers: { "User-Agent": options.userAgent ?? "deckrun", Accept: "*/*" },
    lookup: guardedLookup as RequestOptions["lookup"],
  };

  return new Promise((resolve, reject) => {
    const req = send(requestOptions, resolve);
    req.setTimeout(options.timeoutMs ?? 15_000, () => {
      req.destroy(new Error("timed out"));
    });
    req.once("error", reject);
    req.end();
  });
}

function readCapped(
  response: IncomingMessage,
  maxBytes: number
): Promise<{ body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        resolve({ body: Buffer.concat(chunks).toString("utf-8"), truncated: true });
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () =>
      resolve({ body: Buffer.concat(chunks).toString("utf-8"), truncated: false })
    );
    response.once("error", reject);
  });
}
