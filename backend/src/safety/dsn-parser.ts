/**
 * Reads a delivery status notification (bounce message, RFC 3464).
 *
 * Deliberately conservative. It only reports what the text states: which of
 * OUR messages the notice is about (by Message-ID) and whether the failure
 * is permanent. Who a notice claims to be from proves nothing — anyone can
 * mail something shaped like a bounce — so the caller must still match the
 * Message-ID to a send that really left the mailbox the notice arrived in.
 */

export interface ParsedDsn {
  /** Message-IDs of ours mentioned anywhere in the notice (with angle brackets). */
  messageIds: string[];
  /** 'hard' = permanent failure, 'soft' = temporary/delayed, null = not a failure report. */
  kind: 'hard' | 'soft' | null;
  /** Enhanced status code if present, e.g. '5.1.1'. */
  status: string | null;
  /** Failed recipient named by the notice, lower-cased, if present. */
  recipient: string | null;
  detail: string | null;
}

/** Message-IDs this system generates: <uuid@emailwarm.io> and <reply-uuid@emailwarm.io>. */
const OUR_MESSAGE_ID =
  /<(?:reply-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@emailwarm\.io>/gi;

export function parseDsn(source: string): ParsedDsn {
  // Unfold header continuation lines so multi-line fields read as one.
  const text = source.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');

  const messageIds = [...new Set((text.match(OUR_MESSAGE_ID) ?? []).map((id) => id.toLowerCase()))];

  const action = /^Action:\s*([a-z-]+)/im.exec(text)?.[1]?.toLowerCase() ?? null;
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(text)?.[1] ?? null;
  const diagnostic = /^Diagnostic-Code:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null;
  const recipientRaw =
    /^(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/im.exec(text)?.[1] ??
    /^X-Failed-Recipients:\s*<?([^\s<>,;]+@[^\s<>,;]+)>?/im.exec(text)?.[1] ??
    null;
  // Some servers report only an SMTP reply code in free text.
  const smtpCode =
    /\b(5\d\d)[ -]\d\.\d{1,3}\.\d{1,3}\b/.exec(text)?.[1] ??
    /\b(?:smtp;|error:?|said:?)\s*(5\d\d|4\d\d)\b/i.exec(text)?.[1] ??
    null;

  let kind: ParsedDsn['kind'] = null;
  if (action === 'failed' || status?.startsWith('5.')) kind = 'hard';
  else if (action === 'delayed' || status?.startsWith('4.')) kind = 'soft';
  else if (!action && !status && smtpCode) kind = smtpCode.startsWith('5') ? 'hard' : 'soft';
  // 'delivered', 'relayed' and 'expanded' are success reports, not bounces.
  if (action && ['delivered', 'relayed', 'expanded'].includes(action)) kind = null;
  // A delay notice whose status is permanent is still only a delay.
  if (action === 'delayed') kind = 'soft';

  return {
    messageIds,
    kind,
    status,
    recipient: recipientRaw ? recipientRaw.toLowerCase() : null,
    detail: (diagnostic ?? (status ? `status ${status}` : null))?.slice(0, 300) ?? null,
  };
}
