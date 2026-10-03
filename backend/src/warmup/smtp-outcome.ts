/**
 * Classifies an SMTP submission error (MR-02).
 *
 * SMTP is not exactly-once: if the connection dies after DATA was sent but
 * before the server's reply arrived, the message may or may not have been
 * accepted. Those cases are `uncertain` and must never be blindly resent.
 * `failed` is reserved for errors where the server definitely did not accept
 * the message, which makes a retry safe.
 */
export type SmtpFailureKind = 'failed' | 'uncertain';

/** Wraps a failure that happened before any connection to the mail server was made. */
export class PreSubmissionError extends Error {
  constructor(readonly original: unknown) {
    super((original as Error)?.message ?? 'could not prepare the mail connection');
    this.name = 'PreSubmissionError';
  }
}

// Raised by nodemailer before any message data leaves the process.
const PRE_SUBMISSION_CODES = new Set(['EENVELOPE', 'EAUTH', 'EDNS', 'ECONNECTION', 'ETLS']);

export function classifySmtpError(err: unknown): SmtpFailureKind {
  // Raised while preparing the connection (credentials, host policy): the
  // SMTP conversation never started.
  if (err instanceof PreSubmissionError) return 'failed';
  const e = err as { code?: string; responseCode?: number; command?: string };
  // An explicit SMTP status means the server answered — it said no.
  if (typeof e?.responseCode === 'number' && e.responseCode >= 400) return 'failed';
  if (e?.code && PRE_SUBMISSION_CODES.has(e.code)) return 'failed';
  // Failed while still negotiating (before DATA): nothing was submitted.
  if (e?.command && e.command !== 'DATA') return 'failed';
  return 'uncertain';
}

export function describeSmtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  return [e?.code, e?.responseCode, e?.message].filter(Boolean).join(' ').slice(0, 500);
}

/**
 * True when the receiving side permanently refused the recipient or the
 * message (5xx during RCPT/DATA). Authentication and connection failures are
 * the sender's own operational problems, not bounces.
 */
export function isPermanentRejection(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number };
  if (typeof e?.responseCode !== 'number' || e.responseCode < 500 || e.responseCode > 599) {
    return false;
  }
  return e.code === 'EENVELOPE' || e.code === 'EMESSAGE';
}
