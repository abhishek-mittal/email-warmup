/**
 * Single source of truth for mail transport settings (MR-08).
 *
 * Every code path that opens an SMTP or IMAP connection — interactive OAuth
 * inboxes, batch-imported inboxes and private-pool inboxes — resolves its
 * host/port/TLS mode here so the three can never drift apart again.
 */

export type MailProvider = 'gmail' | 'outlook' | 'custom';

export interface SmtpEndpoint {
  host: string;
  port: number;
}

export interface ImapEndpoint {
  host: string;
  port: number;
}

/**
 * Gmail accepts implicit TLS on 465. Microsoft 365 SMTP submission is
 * STARTTLS on 587 only — smtp.office365.com does not listen for implicit TLS
 * on 465, and forcing `secure: true` on 587 fails the handshake.
 */
const OAUTH_PROVIDER_ENDPOINTS: Record<
  Exclude<MailProvider, 'custom'>,
  { smtp: SmtpEndpoint; imap: ImapEndpoint }
> = {
  gmail: {
    smtp: { host: 'smtp.gmail.com', port: 465 },
    imap: { host: 'imap.gmail.com', port: 993 },
  },
  outlook: {
    smtp: { host: 'smtp.office365.com', port: 587 },
    imap: { host: 'outlook.office365.com', port: 993 },
  },
};

export function isOAuthProvider(provider: string): provider is 'gmail' | 'outlook' {
  return provider === 'gmail' || provider === 'outlook';
}

export function providerEndpoints(provider: 'gmail' | 'outlook') {
  return OAUTH_PROVIDER_ENDPOINTS[provider];
}

/**
 * Plaintext mail transport is refused unless an operator explicitly opts in.
 * The only intended use is the local protocol harness (GreenMail), which
 * speaks unencrypted SMTP/IMAP on loopback.
 */
export function insecureTransportAllowed(): boolean {
  return process.env.MAIL_ALLOW_INSECURE_TRANSPORT === 'true';
}

/**
 * Nodemailer TLS flags for a port: implicit TLS on 465, otherwise a mandatory
 * STARTTLS upgrade. `secure: true` on a STARTTLS port is always wrong.
 */
export function smtpTlsOptions(port: number): { secure: boolean; requireTLS?: boolean } {
  if (port === 465) return { secure: true };
  if (insecureTransportAllowed()) return { secure: false };
  return { secure: false, requireTLS: true };
}

/** ImapFlow TLS flags: implicit TLS on 993, otherwise a mandatory STARTTLS. */
export function imapTlsOptions(port: number): { secure: boolean; doSTARTTLS?: boolean } {
  if (port === 993) return { secure: true };
  if (insecureTransportAllowed()) return { secure: false, doSTARTTLS: false };
  return { secure: false, doSTARTTLS: true };
}

/** Bounded network timeouts shared by SMTP and IMAP clients (ms). */
export const MAIL_TIMEOUTS = {
  connection: 20_000,
  greeting: 15_000,
  socket: 60_000,
} as const;
