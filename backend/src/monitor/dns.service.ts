import { Injectable } from '@nestjs/common';
import * as dns from 'dns';

export type IssueCode =
  | 'SPF_MISSING'
  | 'SPF_INVALID'
  | 'DKIM_MISSING'
  | 'DKIM_INVALID'
  | 'DMARC_MISSING'
  | 'DMARC_INVALID'
  | 'DMARC_NONE'
  | 'MX_MISSING'
  | 'RDNS_MISSING';

/**
 *  - pass:    the record was read and is acceptable.
 *  - fail:    the record was read (or authoritatively does not exist) and is
 *             missing or wrong.
 *  - unknown: the lookup could not be completed (timeout, server failure) or
 *             there was nothing to look up (no selector, no sending IP). An
 *             unknown result says nothing about the domain and must never be
 *             reported as a missing record.
 *
 * `code` may accompany a pass as an advisory (DMARC_NONE: a valid policy that
 * only monitors).
 */
export interface DnsCheckOutcome {
  status: 'pass' | 'fail' | 'unknown';
  code: IssueCode | null;
  detail: string;
}

/** pass -> true, fail -> false, unknown -> null. The shape the *_valid columns store. */
export function outcomeToBoolean(outcome: DnsCheckOutcome | null | undefined): boolean | null {
  if (!outcome || outcome.status === 'unknown') return null;
  return outcome.status === 'pass';
}

// Explicit, well-known public resolvers — see T011 context addendum #1. Using the
// bare dns.promises module-level functions would defer to the system-configured
// resolver, which may return cached/stale results and hide real DNS breakage.
const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

/** "The name, or that record type for it, does not exist" — an authoritative no. */
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/** SPF evaluation stops with a permanent error after ten DNS-querying terms (RFC 7208 4.6.4). */
const SPF_LOOKUP_LIMIT = 10;

/** Selectors the big hosted providers publish by default, tried when none was supplied. */
const PROVIDER_DKIM_SELECTORS: Record<string, string[]> = {
  gmail: ['google'],
  outlook: ['selector1', 'selector2'],
};

class LookupFailed extends Error {}

function unknown(detail: string): DnsCheckOutcome {
  return { status: 'unknown', code: null, detail };
}

@Injectable()
export class DnsService {
  private createResolver(): dns.promises.Resolver {
    const resolver = new dns.promises.Resolver();
    resolver.setServers(DNS_SERVERS);
    return resolver;
  }

  async checkSpf(domain: string): Promise<DnsCheckOutcome> {
    let records: string[];
    try {
      records = await this.resolveTxtFlat(domain);
    } catch {
      return unknown(`SPF lookup for ${domain} did not complete`);
    }

    const spfRecords = records.filter((record) => /^v=spf1(\s|$)/i.test(record.trim()));
    if (spfRecords.length === 0) {
      return { status: 'fail', code: 'SPF_MISSING', detail: 'No v=spf1 TXT record found' };
    }
    if (spfRecords.length > 1) {
      // Receivers treat more than one SPF record as a permanent error.
      return {
        status: 'fail',
        code: 'SPF_INVALID',
        detail: `${spfRecords.length} SPF records found; a domain must publish exactly one`,
      };
    }

    const spfRecord = spfRecords[0].trim();
    const lookups = spfRecord
      .split(/\s+/)
      .filter((term) =>
        /^[+?~-]?(include:|a(:|\/|$)|mx(:|\/|$)|ptr(:|$)|exists:)|^redirect=/i.test(term),
      ).length;
    if (lookups > SPF_LOOKUP_LIMIT) {
      return {
        status: 'fail',
        code: 'SPF_INVALID',
        detail: `SPF record needs ${lookups} DNS lookups; the limit is ${SPF_LOOKUP_LIMIT}`,
      };
    }

    return { status: 'pass', code: null, detail: spfRecord };
  }

  async checkDkim(domain: string, selector: string): Promise<DnsCheckOutcome> {
    const name = `${selector}._domainkey.${domain}`;
    let records: string[];
    try {
      records = await this.resolveTxtFlat(name);
    } catch {
      return unknown(`DKIM lookup for ${name} did not complete`);
    }

    if (records.length === 0) {
      return {
        status: 'fail',
        code: 'DKIM_MISSING',
        detail: `No TXT record found at ${name}`,
      };
    }

    const dkimRecord = records.join('');
    const pValueMatch = dkimRecord.match(/(?:^|;)\s*p=([^;]*)/);
    const pValue = pValueMatch?.[1]?.trim();

    if (!pValue) {
      // An empty p= is how a key is revoked.
      return {
        status: 'fail',
        code: 'DKIM_INVALID',
        detail: `TXT record at ${name} has no non-empty p= value`,
      };
    }

    return { status: 'pass', code: null, detail: dkimRecord };
  }

  /**
   * DKIM when the selector may not be known. A selector the owner supplied is
   * checked as given. Without one, the provider's usual selectors are tried:
   * finding a key is a pass, but NOT finding one proves nothing (the domain
   * may sign with any selector), so that case is unknown rather than a
   * failure. DKIM is never reported as passing without a key having been read.
   */
  async checkDkimForInbox(
    domain: string,
    selector: string | null | undefined,
    provider: string,
  ): Promise<DnsCheckOutcome> {
    if (selector) return this.checkDkim(domain, selector);

    for (const candidate of PROVIDER_DKIM_SELECTORS[provider] ?? []) {
      const outcome = await this.checkDkim(domain, candidate);
      if (outcome.status === 'pass') return outcome;
    }
    return unknown('No DKIM selector is known for this inbox, so DKIM could not be checked');
  }

  async checkDmarc(domain: string): Promise<DnsCheckOutcome> {
    const name = `_dmarc.${domain}`;
    let records: string[];
    try {
      records = await this.resolveTxtFlat(name);
    } catch {
      return unknown(`DMARC lookup for ${name} did not complete`);
    }

    const dmarcRecords = records.filter((record) => /^v=DMARC1\s*(;|$)/i.test(record.trim()));
    if (dmarcRecords.length === 0) {
      return {
        status: 'fail',
        code: 'DMARC_MISSING',
        detail:
          records.length === 0
            ? `No TXT record found at ${name}`
            : `TXT record at ${name} is not a DMARC record (it must start with v=DMARC1)`,
      };
    }
    if (dmarcRecords.length > 1) {
      return {
        status: 'fail',
        code: 'DMARC_INVALID',
        detail: `${dmarcRecords.length} DMARC records found at ${name}; there must be exactly one`,
      };
    }

    const dmarcRecord = dmarcRecords[0].trim();
    const policy = dmarcRecord
      .match(/(?:^|;)\s*p=([^;]*)/i)?.[1]
      ?.trim()
      .toLowerCase();

    if (!policy || !['none', 'quarantine', 'reject'].includes(policy)) {
      return {
        status: 'fail',
        code: 'DMARC_INVALID',
        detail: `DMARC record has no valid p= policy (none, quarantine or reject): ${dmarcRecord}`,
      };
    }

    // p=none is a valid, deliberately monitoring-only policy. It is flagged as
    // advice, not as broken authentication.
    if (policy === 'none') {
      return { status: 'pass', code: 'DMARC_NONE', detail: dmarcRecord };
    }

    return { status: 'pass', code: null, detail: dmarcRecord };
  }

  async checkMx(domain: string): Promise<DnsCheckOutcome> {
    try {
      const resolver = this.createResolver();
      const records = await resolver.resolveMx(domain);

      // A single MX of "." is a null MX: the domain declares it accepts no mail.
      const usable = records.filter((record) => record.exchange && record.exchange !== '.');
      if (usable.length === 0) {
        return {
          status: 'fail',
          code: 'MX_MISSING',
          detail:
            records.length === 0
              ? 'No MX records found'
              : 'Domain publishes a null MX (it does not accept mail)',
        };
      }

      return {
        status: 'pass',
        code: null,
        detail: usable
          .map((record) => `${record.exchange} (priority ${record.priority})`)
          .join(', '),
      };
    } catch (error) {
      if (NOT_FOUND_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) {
        return { status: 'fail', code: 'MX_MISSING', detail: 'No MX records found' };
      }
      return unknown(`MX lookup for ${domain} did not complete`);
    }
  }

  async checkRdns(ip: string): Promise<DnsCheckOutcome> {
    try {
      // dns.reverse() does not support a custom Resolver instance in Node's API —
      // see T011 context addendum #1. Only the TXT/MX lookups above need the
      // explicit-resolver treatment.
      const hostnames = await dns.promises.reverse(ip);

      if (hostnames.length === 0) {
        return { status: 'fail', code: 'RDNS_MISSING', detail: 'No PTR record found' };
      }

      return { status: 'pass', code: null, detail: hostnames[0] };
    } catch (error) {
      if (NOT_FOUND_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) {
        return { status: 'fail', code: 'RDNS_MISSING', detail: 'No PTR record found' };
      }
      return unknown(`Reverse lookup for ${ip} did not complete`);
    }
  }

  /**
   * TXT strings at `name`, each record's chunks joined. Returns [] only when
   * the resolver authoritatively says there are none; a timeout or server
   * failure throws, so callers can tell "missing" from "couldn't check".
   */
  private async resolveTxtFlat(name: string): Promise<string[]> {
    try {
      const resolver = this.createResolver();
      const records = await resolver.resolveTxt(name);
      return records.map((record) => record.join(''));
    } catch (error) {
      if (NOT_FOUND_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) return [];
      throw new LookupFailed((error as Error)?.message);
    }
  }
}
