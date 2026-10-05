import { BlockList, isIP } from 'net';
import { promises as dns } from 'dns';

/**
 * Outbound connection policy for hosts a customer supplies (MR-11).
 *
 * A custom SMTP/IMAP host is attacker-controlled input: without a check it
 * can point the server at loopback, the private network or a cloud metadata
 * endpoint. Every such host is resolved here, every address it resolves to
 * must be public, and the caller then connects to the exact address that was
 * checked (keeping the hostname only for TLS), so a second DNS answer cannot
 * swap in a different target between the check and the connection.
 */

export class EgressDeniedError extends Error {
  constructor(
    readonly host: string,
    reason: string,
  ) {
    super(`Connections to ${host} are not allowed: ${reason}`);
    this.name = 'EgressDeniedError';
  }
}

export interface CheckedHost {
  /** The address to connect to. */
  address: string;
  family: 4 | 6;
  /** The original hostname, for TLS SNI and certificate checks; undefined when the input was an IP literal. */
  servername?: string;
}

const blocked = new BlockList();
// IPv4: this-network, private, CGNAT, loopback, link-local (incl. metadata
// 169.254.169.254), protocol assignments, documentation, benchmarking,
// multicast, reserved and broadcast.
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
// IPv6: unspecified, loopback, unique-local, link-local, multicast,
// documentation, and the transition prefixes that embed an IPv4 address.
for (const [net, prefix] of [
  ['::', 127], // :: and ::1
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96], // NAT64
  ['2002::', 16], // 6to4
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address it carries. */
function unmap(address: string): { address: string; family: 4 | 6 } {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return { address: mapped[1], family: 4 };
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return { address: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 4 };
  }
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

export function isPublicAddress(input: string): boolean {
  const version = isIP(input);
  if (version === 0) return false;
  const { address, family } = unmap(input);
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Hosts or addresses an operator has explicitly allowed despite the policy
 * (comma-separated `MAIL_EGRESS_ALLOWLIST`), e.g. an on-prem relay, or
 * 127.0.0.1 for the local protocol harness. Matched against both the name
 * the customer typed and each address it resolves to.
 */
function allowlist(): Set<string> {
  return new Set(
    (process.env.MAIL_EGRESS_ALLOWLIST ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Syntactic checks that need no DNS: usable as early request validation. */
export function assertHostSyntax(host: unknown): asserts host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    throw new EgressDeniedError(String(host).slice(0, 60), 'not a valid host name');
  }
  // Letters, digits, dots, hyphens; or an IPv6 literal. Rules out URLs,
  // credentials, ports, whitespace and path tricks.
  if (!/^[A-Za-z0-9.-]+$/.test(host) && isIP(host) !== 6) {
    throw new EgressDeniedError(host.slice(0, 60), 'not a valid host name');
  }
}

/**
 * Resolves `host` and returns the address to connect to, or throws
 * EgressDeniedError. If the name resolves to several addresses and ANY of
 * them is non-public the host is refused outright — a name that answers with
 * both a public and a private address is exactly what a rebinding attack
 * looks like.
 */
export async function resolvePublicHost(
  host: string,
  resolver: Resolver = systemResolver,
): Promise<CheckedHost> {
  assertHostSyntax(host);
  const name = host.toLowerCase().replace(/\.$/, '');
  const allowed = allowlist();

  if (isIP(name)) {
    if (!allowed.has(name) && !isPublicAddress(name)) {
      throw new EgressDeniedError(host, 'the address is private, local or reserved');
    }
    const { address, family } = unmap(name);
    return { address, family };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await resolver(name);
  } catch {
    throw new EgressDeniedError(host, 'the host name could not be resolved');
  }
  if (answers.length === 0) {
    throw new EgressDeniedError(host, 'the host name could not be resolved');
  }

  if (!allowed.has(name)) {
    for (const answer of answers) {
      if (!allowed.has(answer.address.toLowerCase()) && !isPublicAddress(answer.address)) {
        throw new EgressDeniedError(host, 'it resolves to a private, local or reserved address');
      }
    }
  }

  const first = unmap(answers[0].address);
  return { address: first.address, family: first.family, servername: name };
}

/** Valid TCP port as an integer, or throws. */
export function assertPort(port: unknown): number {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new EgressDeniedError(String(port).slice(0, 12), 'not a valid port');
  }
  return value;
}
