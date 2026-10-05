import { Injectable, Logger } from '@nestjs/common';
import * as dns from 'dns';
import { isIP } from 'net';
import { RBL_ZONES, RblZone } from './rbl-list';

/**
 *  - listed:  the operator answered that the subject is on its list.
 *  - clean:   the operator answered that it is not (NXDOMAIN).
 *  - unknown: no usable answer — the query was refused, timed out, errored,
 *             the zone is disabled, or the zone needs a sending IP that isn't
 *             known. Unknown is never treated as clean and never as listed.
 */
export type RblStatus = 'clean' | 'listed' | 'unknown';

export interface BlacklistCheckResult {
  /**
   * true  = at least one zone answered and none listed the sender;
   * false = at least one zone listed it;
   * null  = no zone gave a usable answer, so nothing is known either way.
   */
  isClean: boolean | null;
  listed: string[];
  listedCount: number;
  rblResults: Record<string, RblStatus>;
  /** Zones that gave a real answer (clean or listed). */
  checkedCount: number;
  /** Zones that gave none. */
  unknownCount: number;
}

const RBL_TIMEOUT_MS = 5_000;

// NXDOMAIN-equivalent codes from Node's dns module — see T012 context addendum #6.
const NXDOMAIN_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/** Coverage summary derived from a stored rbl_results value. */
export function rblCoverage(rblResults: unknown): {
  checked: number;
  unknown: number;
  listed: number;
} {
  const values = Object.values((rblResults as Record<string, string>) ?? {});
  return {
    checked: values.filter((v) => v === 'clean' || v === 'listed').length,
    unknown: values.filter((v) => v !== 'clean' && v !== 'listed').length,
    listed: values.filter((v) => v === 'listed').length,
  };
}

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  /**
   * Checks a sender against every enabled zone in parallel. Domain zones are
   * asked about `domain`; IP zones are asked about `sendingIp`, and report
   * unknown when it isn't known — a domain's A or MX address is not the
   * address mail is sent from, so it is never substituted.
   */
  async check(domain: string, sendingIp?: string | null): Promise<BlacklistCheckResult> {
    const statuses = await Promise.all(
      RBL_ZONES.map((entry) => this.checkZone(entry, domain, sendingIp ?? null)),
    );

    const rblResults: Record<string, RblStatus> = {};
    const listed: string[] = [];
    statuses.forEach((status, index) => {
      const { zone } = RBL_ZONES[index];
      rblResults[zone] = status;
      if (status === 'listed') listed.push(zone);
    });

    const checkedCount = statuses.filter((s) => s !== 'unknown').length;
    return {
      isClean: listed.length > 0 ? false : checkedCount > 0 ? true : null,
      listed,
      listedCount: listed.length,
      rblResults,
      checkedCount,
      unknownCount: statuses.length - checkedCount,
    };
  }

  /** Kept for callers that only have a domain; IP zones report unknown. */
  async checkDomain(domain: string): Promise<BlacklistCheckResult> {
    return this.check(domain, null);
  }

  private async checkZone(
    entry: RblZone,
    domain: string,
    sendingIp: string | null,
  ): Promise<RblStatus> {
    if (!entry.enabled) return 'unknown';

    const subject = entry.kind === 'ip' ? this.reverseIp(sendingIp) : domain.toLowerCase();
    if (!subject) return 'unknown';

    const query = `${subject}.${this.queryZone(entry.zone)}`;
    try {
      const addresses = await this.withTimeout(this.resolve4(query), RBL_TIMEOUT_MS);
      if (addresses.some((address) => entry.isError(address))) {
        this.logger.warn(`RBL ${entry.zone} refused the query (answer ${addresses.join(',')})`);
        return 'unknown';
      }
      if (addresses.some((address) => entry.isListing(address))) return 'listed';
      // An answer that is neither a documented listing nor a documented error
      // tells us nothing we can stand behind.
      return 'unknown';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && NXDOMAIN_CODES.has(code)) return 'clean';
      this.logger.warn(
        `RBL lookup failed for ${entry.zone}: ${(error as Error)?.message ?? error}`,
      );
      return 'unknown';
    }
  }

  /**
   * With a Spamhaus Data Query Service key the Spamhaus zones are queried
   * through the keyed hostnames, which answer from any network.
   */
  private queryZone(zone: string): string {
    const key = process.env.SPAMHAUS_DQS_KEY?.trim();
    if (key && zone.endsWith('.spamhaus.org')) {
      return `${key}.${zone.replace('.spamhaus.org', '')}.dq.spamhaus.net`;
    }
    return zone;
  }

  /** IPv4 octets reversed, as IP blocklists expect. IPv6 senders are not supported yet. */
  private reverseIp(ip: string | null): string | null {
    if (!ip || isIP(ip) !== 4) return null;
    return ip.split('.').reverse().join('.');
  }

  protected resolve4(name: string): Promise<string[]> {
    return dns.promises.resolve4(name);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RBL lookup timed out')), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
