import type { IssueCatalogEntry } from './types';

export const ISSUE_CATALOG: Record<string, IssueCatalogEntry> = {
  SPF_MISSING: {
    code: 'SPF_MISSING',
    title: 'SPF record missing or invalid',
    severity: 'critical',
    icon: 'shield',
    explanation:
      'Your sending domain does not publish a valid SPF (Sender Policy Framework) record. Without SPF, receiving mail servers cannot verify that your emails come from an authorized sending IP, which causes them to flag your messages as suspicious.',
    fixSteps: [
      'Add a TXT record to your domain (e.g. _spf.yourdomain.com or yourdomain.com) in your DNS provider.',
      'Include every IP address or hostname that sends mail for this domain (e.g. "v=spf1 ip4:192.0.2.1 include:_spf.google.com -all").',
      'Limit to 10 DNS lookups total in the SPF record to stay under the RFC limit.',
      'Re-run the DNS check from the inbox detail page to confirm the fix.',
    ],
  },
  DKIM_MISSING: {
    code: 'DKIM_MISSING',
    title: 'DKIM signature missing or invalid',
    severity: 'critical',
    icon: 'key',
    explanation:
      'Your outbound mail is not being signed with DKIM (DomainKeys Identified Mail). DKIM cryptographically proves the message has not been tampered with in transit; without it, Gmail and Outlook treat your messages as unverified.',
    fixSteps: [
      'Generate a DKIM key pair in your email service provider (Google Workspace, Microsoft 365, SendGrid, etc.).',
      'Publish the public key as a TXT record at <selector>._domainkey.yourdomain.com.',
      'Configure your mail server to sign outbound messages with the corresponding private key.',
      'Verify with a DKIM checker (e.g. mail-tester.com) and re-run the inbox DNS check.',
    ],
  },
  DMARC_MISSING: {
    code: 'DMARC_MISSING',
    title: 'DMARC policy not published',
    severity: 'warning',
    icon: 'policy',
    explanation:
      'You do not have a DMARC (Domain-based Message Authentication, Reporting & Conformance) policy. DMARC ties SPF and DKIM together and tells receiving servers what to do with mail that fails both checks.',
    fixSteps: [
      'Start with a monitoring policy: "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com".',
      'Analyze the reports for 2-4 weeks to identify all legitimate senders.',
      'Tighten to "p=quarantine" then "p=reject" once you are confident no legitimate mail will be blocked.',
    ],
  },
  MX_MISSING: {
    code: 'MX_MISSING',
    title: 'MX records missing',
    severity: 'critical',
    icon: 'server',
    explanation:
      'Your domain has no MX (Mail Exchange) records. Mail servers use MX records to know where to deliver email for your domain. A missing MX record will cause major deliverability problems.',
    fixSteps: [
      'Add MX records in your DNS provider pointing to your mail server (e.g. Google Workspace, Microsoft 365, or your custom mail host).',
      'Priority should be a low number (10 is standard) for your primary mail server.',
      'Re-run the DNS check from the inbox detail page to verify.',
    ],
  },
  RDNS_MISSING: {
    code: 'RDNS_MISSING',
    title: 'Reverse DNS (PTR) record missing',
    severity: 'warning',
    icon: 'arrow',
    explanation:
      'Your sending IP address does not have a reverse DNS (PTR) record. Many mail servers (especially at Gmail) reject or spam-flag mail from IPs without valid rDNS.',
    fixSteps: [
      'Contact your hosting provider or ISP and request a PTR record for your sending IP that points back to your mail server hostname.',
      'The PTR record hostname should itself resolve forward to the IP (forward-confirmed rDNS).',
      'Allow up to 24 hours for DNS propagation, then re-run the DNS check.',
    ],
  },
  BLACKLIST_HIT: {
    code: 'BLACKLIST_HIT',
    title: 'Domain or IP listed on a blacklist',
    severity: 'critical',
    icon: 'ban',
    explanation:
      'Your sending domain or IP address has been listed on one or more Real-time Blackhole Lists (RBLs). Most receiving mail servers reject or quarantine mail from listed senders.',
    fixSteps: [
      'Identify which RBL has you listed (see the blacklist section on the inbox detail page).',
      'Visit the RBL’s delisting URL and follow their specific removal procedure.',
      'Investigate the root cause (compromised account, spam complaint spike, unsolicited bulk mail).',
      'Request delisting and prepare documentation of the remediation for the RBL operator.',
    ],
  },
  SPAM_RATE_HIGH: {
    code: 'SPAM_RATE_HIGH',
    title: 'Spam-folder placement above 20%',
    severity: 'critical',
    icon: 'trash',
    explanation:
      'More than 20% of your placement-test seed messages landed in the spam folder. This is a strong negative reputation signal — receiving servers are actively distrusting your messages.',
    fixSteps: [
      'Review recent content for spam triggers (all-caps, exclamation marks, link-heavy bodies, sales language).',
      'Verify SPF, DKIM, and DMARC are all valid (fix those first).',
      'Reduce send volume by 30-50% for one week to let reputation recover.',
      'Run a new placement test in 7 days to confirm recovery.',
    ],
  },
  PROMOTIONS_RATE_HIGH: {
    code: 'PROMOTIONS_RATE_HIGH',
    title: 'Promotions-tab placement above 30%',
    severity: 'warning',
    icon: 'tag',
    explanation:
      'More than 30% of your placement-test seed messages landed in the Promotions tab. This is not as bad as spam, but it dramatically reduces open rates and engagement.',
    fixSteps: [
      'Personalize subject lines and preheader text — avoid words that trigger Promotions heuristics ("sale", "free", "deal").',
      'Use plain-text formatting and limit image count.',
      'Encourage replies and interaction (replies are a strong Primary-tab signal).',
      'Warm up further before sending high-volume campaigns.',
    ],
  },
};

export function getIssueEntry(code: string): IssueCatalogEntry {
  return (
    ISSUE_CATALOG[code] ?? {
      code,
      title: code,
      severity: 'info',
      icon: 'info',
      explanation: 'An issue was detected. See the inbox detail page for more detail.',
      fixSteps: ['Review the inbox detail page.'],
    }
  );
}
