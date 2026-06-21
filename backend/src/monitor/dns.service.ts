import { Injectable } from '@nestjs/common';
import * as dns from 'dns';

export type IssueCode =
  | 'SPF_MISSING'
  | 'DKIM_MISSING'
  | 'DKIM_INVALID'
  | 'DMARC_MISSING'
  | 'DMARC_NONE'
  | 'MX_MISSING'
  | 'RDNS_MISSING';

export interface DnsCheckOutcome {
  status: 'pass' | 'fail';
  code: IssueCode | null;
  detail: string;
}

// Explicit, well-known public resolvers — see T011 context addendum #1. Using the
// bare dns.promises module-level functions would defer to the system-configured
// resolver, which may return cached/stale results and hide real DNS breakage.
const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

@Injectable()
export class DnsService {
  private createResolver(): dns.promises.Resolver {
    const resolver = new dns.promises.Resolver();
    resolver.setServers(DNS_SERVERS);
    return resolver;
  }

  async checkSpf(domain: string): Promise<DnsCheckOutcome> {
    const records = await this.resolveTxtFlat(domain);
    const spfRecord = records.find((record) => record.startsWith('v=spf1'));

    if (!spfRecord) {
      return { status: 'fail', code: 'SPF_MISSING', detail: 'No v=spf1 TXT record found' };
    }

    return { status: 'pass', code: null, detail: spfRecord };
  }

  async checkDkim(domain: string, selector: string): Promise<DnsCheckOutcome> {
    const name = `${selector}._domainkey.${domain}`;
    const records = await this.resolveTxtFlat(name);

    if (records.length === 0) {
      return {
        status: 'fail',
        code: 'DKIM_MISSING',
        detail: `No TXT record found at ${name}`,
      };
    }

    const dkimRecord = records.join('');
    const pValueMatch = dkimRecord.match(/p=([^;]*)/);
    const pValue = pValueMatch?.[1]?.trim();

    if (!pValue) {
      return {
        status: 'fail',
        code: 'DKIM_INVALID',
        detail: `TXT record at ${name} has no non-empty p= value`,
      };
    }

    return { status: 'pass', code: null, detail: dkimRecord };
  }

  async checkDmarc(domain: string): Promise<DnsCheckOutcome> {
    const name = `_dmarc.${domain}`;
    const records = await this.resolveTxtFlat(name);

    if (records.length === 0) {
      return {
        status: 'fail',
        code: 'DMARC_MISSING',
        detail: `No TXT record found at ${name}`,
      };
    }

    const dmarcRecord = records.join('');
    const pValueMatch = dmarcRecord.match(/p=([^;]*)/);
    const pValue = pValueMatch?.[1]?.trim();

    if (pValue === 'none') {
      return { status: 'fail', code: 'DMARC_NONE', detail: dmarcRecord };
    }

    return { status: 'pass', code: null, detail: dmarcRecord };
  }

  async checkMx(domain: string): Promise<DnsCheckOutcome> {
    try {
      const resolver = this.createResolver();
      const records = await resolver.resolveMx(domain);

      if (records.length === 0) {
        return { status: 'fail', code: 'MX_MISSING', detail: 'No MX records found' };
      }

      return {
        status: 'pass',
        code: null,
        detail: records
          .map((record) => `${record.exchange} (priority ${record.priority})`)
          .join(', '),
      };
    } catch {
      return { status: 'fail', code: 'MX_MISSING', detail: 'No MX records found' };
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
    } catch {
      return { status: 'fail', code: 'RDNS_MISSING', detail: 'No PTR record found' };
    }
  }

  private async resolveTxtFlat(name: string): Promise<string[]> {
    try {
      const resolver = this.createResolver();
      const records = await resolver.resolveTxt(name);
      return records.map((record) => record.join(''));
    } catch {
      return [];
    }
  }
}
