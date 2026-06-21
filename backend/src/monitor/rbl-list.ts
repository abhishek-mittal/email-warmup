// Minimum RBL zone list per the monitoring service spec (__specs__/services/monitoring.md).
//
// The spec also describes an "extended list (100+)" sourced from a paid MXToolbox
// API subscription — that data source is not available in this environment, so we
// don't fabricate additional RBL hostnames to pad this list (see T012 context
// addendum #1). When an MXToolbox (or equivalent) subscription is wired up, the
// extended zones should be appended here.
export const RBL_LIST: string[] = [
  'zen.spamhaus.org',
  'dbl.spamhaus.org',
  'bl.spamcop.net',
  'b.barracudacentral.org',
  'multi.surbl.org',
  'combined.abuse.ch',
  'dnsbl.sorbs.net',
  'spam.dnsbl.sorbs.net',
];
