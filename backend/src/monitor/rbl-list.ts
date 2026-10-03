/**
 * Blocklist zone registry (MR-13).
 *
 * A DNS blocklist is queried by prepending either the sender's domain or its
 * sending IP (octets reversed) to the zone, and the answer is a 127.x.x.x
 * address whose value carries the meaning. Three things differ per zone and
 * getting any of them wrong produces false results:
 *
 *  - what it lists (`kind`): asking an IP list about a domain name, or the
 *    other way round, is not a valid query;
 *  - which answers mean "listed";
 *  - which answers mean "your query was refused or malformed" — those are
 *    operational errors, never evidence about the sender.
 *
 * Only zones that are currently operated and whose answer codes are
 * documented by their operator are enabled. Retired zones are kept, disabled,
 * so stored history that names them stays explainable. The product's "100+
 * blocklists" claim is NOT met by this list; widening it means licensed
 * access to an aggregator, not adding zone names.
 */

export type RblKind = 'ip' | 'domain';

export interface RblZone {
  zone: string;
  kind: RblKind;
  enabled: boolean;
  /** True when this A-record answer means the subject is listed. */
  isListing: (address: string) => boolean;
  /** True when this answer is the operator refusing or rejecting the query. */
  isError: (address: string) => boolean;
  note?: string;
}

const last = (address: string) => Number(address.split('.')[3]);
const startsWith = (prefix: string) => (address: string) => address.startsWith(prefix);

/**
 * Spamhaus answers 127.255.255.x when it will not serve the query: 252 for a
 * malformed query, 254 for queries arriving through a public/open resolver,
 * 255 for excessive volume. From cloud networks and public resolvers this is
 * the normal answer unless a Data Query Service key is used.
 */
const spamhausError = startsWith('127.255.255.');

export const RBL_ZONES: RblZone[] = [
  {
    zone: 'zen.spamhaus.org',
    kind: 'ip',
    enabled: true,
    // SBL .2/.3/.9, XBL .4-.7, PBL .10/.11
    isListing: (a) => a.startsWith('127.0.0.') && last(a) >= 2 && last(a) <= 11,
    isError: spamhausError,
  },
  {
    zone: 'dbl.spamhaus.org',
    kind: 'domain',
    enabled: true,
    // 127.0.1.2 - 127.0.1.106 are listings; 127.0.1.255 means "an IP was queried".
    isListing: (a) => a.startsWith('127.0.1.') && last(a) >= 2 && last(a) <= 106,
    isError: (a) => spamhausError(a) || a === '127.0.1.255',
  },
  {
    zone: 'bl.spamcop.net',
    kind: 'ip',
    enabled: true,
    isListing: (a) => a === '127.0.0.2',
    isError: () => false,
  },
  {
    zone: 'b.barracudacentral.org',
    kind: 'ip',
    enabled: true,
    isListing: (a) => a === '127.0.0.2',
    isError: () => false,
    note: 'Barracuda expects the querying resolver to be registered with them.',
  },
  {
    zone: 'multi.surbl.org',
    kind: 'domain',
    enabled: true,
    // The last octet is a bitmask of member lists. 127.0.0.1 is SURBL's
    // "access blocked" answer for public resolvers and heavy users.
    isListing: (a) => a.startsWith('127.0.0.') && last(a) >= 2,
    isError: (a) => a === '127.0.0.1',
  },
  {
    zone: 'combined.abuse.ch',
    kind: 'ip',
    enabled: false,
    isListing: () => false,
    isError: () => true,
    note: 'Retired by its operator; no longer answers.',
  },
  {
    zone: 'dnsbl.sorbs.net',
    kind: 'ip',
    enabled: false,
    isListing: () => false,
    isError: () => true,
    note: 'SORBS was shut down in June 2024.',
  },
  {
    zone: 'spam.dnsbl.sorbs.net',
    kind: 'ip',
    enabled: false,
    isListing: () => false,
    isError: () => true,
    note: 'SORBS was shut down in June 2024.',
  },
];

/** Zone names, for callers that only need labels (kept for existing imports). */
export const RBL_LIST: string[] = RBL_ZONES.map((entry) => entry.zone);
