import { parseDsn } from './dsn-parser';

const ID = '<3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b@emailwarm.io>';

function dsn(fields: string, original = `Message-ID: ${ID}`): string {
  return [
    'From: MAILER-DAEMON@mx.example.net',
    'Subject: Undelivered Mail Returned to Sender',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'This is the mail system. Your message could not be delivered.',
    '',
    '--b',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.net',
    '',
    fields,
    '',
    '--b',
    'Content-Type: text/rfc822-headers',
    '',
    original,
    'Subject: Quick hello',
    '--b--',
  ].join('\r\n');
}

describe('parseDsn', () => {
  it('reads a permanent failure with its message, status and recipient', () => {
    const parsed = parseDsn(
      dsn(
        [
          'Final-Recipient: rfc822; Nobody@Partner.example',
          'Action: failed',
          'Status: 5.1.1',
          'Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach',
          '    does not exist.',
        ].join('\r\n'),
      ),
    );
    expect(parsed.kind).toBe('hard');
    expect(parsed.status).toBe('5.1.1');
    expect(parsed.recipient).toBe('nobody@partner.example');
    expect(parsed.messageIds).toEqual([ID]);
    expect(parsed.detail).toContain('does not exist');
  });

  it('treats a delay notice as soft even when it mentions a 5.x status', () => {
    expect(parseDsn(dsn('Action: delayed\r\nStatus: 4.4.1')).kind).toBe('soft');
    expect(parseDsn(dsn('Action: delayed\r\nStatus: 5.4.7')).kind).toBe('soft');
  });

  it('does not treat a success report as a bounce', () => {
    expect(parseDsn(dsn('Action: delivered\r\nStatus: 2.0.0')).kind).toBeNull();
    expect(parseDsn(dsn('Action: relayed\r\nStatus: 2.0.0')).kind).toBeNull();
  });

  it('reads a free-text bounce that carries only an SMTP reply code', () => {
    const parsed = parseDsn(
      `From: postmaster@mx.example\r\n\r\nThe server said: 550 mailbox unavailable\r\nOriginal message id ${ID}`,
    );
    expect(parsed.kind).toBe('hard');
    expect(parsed.messageIds).toEqual([ID]);
  });

  it('finds only message ids this system generates, deduplicated and lower-cased', () => {
    const parsed = parseDsn(
      dsn(
        'Action: failed\r\nStatus: 5.0.0',
        `Message-ID: ${ID.toUpperCase()}\r\nReferences: ${ID} <someone-else@other.example> <not-a-uuid@emailwarm.io>`,
      ),
    );
    expect(parsed.messageIds).toEqual([ID]);
  });

  it('returns nothing to act on for ordinary mail', () => {
    const parsed = parseDsn(
      'From: friend@example.com\r\nSubject: lunch?\r\n\r\nSee you at 550 Main St.',
    );
    expect(parsed.messageIds).toEqual([]);
    expect(parsed.kind).toBeNull();
  });

  it('recognises a reply message id of ours', () => {
    const replyId = '<reply-3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b@emailwarm.io>';
    expect(
      parseDsn(dsn('Action: failed\r\nStatus: 5.2.2', `Message-ID: ${replyId}`)).messageIds,
    ).toEqual([replyId]);
  });
});
