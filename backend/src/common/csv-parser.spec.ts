import { parseInboxBatchCsv } from './csv-parser';

describe('parseInboxBatchCsv', () => {
  it('parses a gmail row into the batch-entry shape', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token,smtp_host,smtp_port,smtp_user,smtp_password,imap_host,imap_port,imap_user,imap_password\n' +
      'a@domain.com,gmail,cid123,csecret456,rtoken789,,,,,,,,\n';

    const rows = parseInboxBatchCsv(csv);

    expect(rows).toEqual([
      {
        email: 'a@domain.com',
        provider: 'gmail',
        clientId: 'cid123',
        clientSecret: 'csecret456',
        refreshToken: 'rtoken789',
      },
    ]);
  });

  it('parses an outlook row into the batch-entry shape', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token\n' +
      'b@domain.com,outlook,cid2,csecret2,rtoken2\n';

    const rows = parseInboxBatchCsv(csv);

    expect(rows).toEqual([
      {
        email: 'b@domain.com',
        provider: 'outlook',
        clientId: 'cid2',
        clientSecret: 'csecret2',
        refreshToken: 'rtoken2',
      },
    ]);
  });

  it('parses a custom row into the batch-entry shape with numeric ports', () => {
    const csv =
      'email,provider,smtp_host,smtp_port,smtp_user,smtp_password,imap_host,imap_port,imap_user,imap_password\n' +
      'c@domain.com,custom,smtp.domain.com,587,c@domain.com,smtppass,imap.domain.com,993,c@domain.com,imappass\n';

    const rows = parseInboxBatchCsv(csv);

    expect(rows).toEqual([
      {
        email: 'c@domain.com',
        provider: 'custom',
        smtpHost: 'smtp.domain.com',
        smtpPort: 587,
        smtpUser: 'c@domain.com',
        smtpPassword: 'smtppass',
        imapHost: 'imap.domain.com',
        imapPort: 993,
        imapUser: 'c@domain.com',
        imapPassword: 'imappass',
      },
    ]);
  });

  it('supports mixed providers in one file, detected per row', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token,smtp_host,smtp_port,smtp_user,smtp_password,imap_host,imap_port,imap_user,imap_password\n' +
      'a@domain.com,gmail,cid,csec,rtok,,,,,,,,\n' +
      'c@domain.com,custom,,,,smtp.domain.com,587,c@domain.com,spw,imap.domain.com,993,c@domain.com,ipw\n';

    const rows = parseInboxBatchCsv(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0].provider).toBe('gmail');
    expect(rows[1].provider).toBe('custom');
  });

  it('skips the header row', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token\na@domain.com,gmail,cid,csec,rtok\n';
    const rows = parseInboxBatchCsv(csv);
    expect(rows).toHaveLength(1);
  });

  it('skips blank rows', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token\n' +
      'a@domain.com,gmail,cid,csec,rtok\n' +
      '\n' +
      '   \n' +
      'b@domain.com,outlook,cid2,csec2,rtok2\n';
    const rows = parseInboxBatchCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('returns a structured malformed entry for a row missing required oauth fields', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token\n' + 'a@domain.com,gmail,cid,,rtok\n'; // missing client_secret

    const rows = parseInboxBatchCsv(csv);

    expect(rows).toEqual([
      {
        email: 'a@domain.com',
        provider: 'gmail',
        __malformed: true,
        __reason: expect.stringContaining('client_secret'),
      },
    ]);
  });

  it('returns a structured malformed entry for a row missing required custom fields', () => {
    const csv =
      'email,provider,smtp_host,smtp_port,smtp_user,smtp_password,imap_host,imap_port,imap_user,imap_password\n' +
      'c@domain.com,custom,smtp.domain.com,587,,smtppass,imap.domain.com,993,c@domain.com,imappass\n'; // missing smtp_user

    const rows = parseInboxBatchCsv(csv);

    expect(rows).toEqual([
      {
        email: 'c@domain.com',
        provider: 'custom',
        __malformed: true,
        __reason: expect.stringContaining('smtp_user'),
      },
    ]);
  });

  it('returns a structured malformed entry for an unknown provider value', () => {
    const csv = 'email,provider\na@domain.com,yahoo\n';
    const rows = parseInboxBatchCsv(csv);
    expect(rows).toEqual([
      {
        email: 'a@domain.com',
        provider: 'yahoo',
        __malformed: true,
        __reason: expect.stringContaining('provider'),
      },
    ]);
  });

  it('returns a structured malformed entry when email is missing', () => {
    const csv = 'email,provider,client_id,client_secret,refresh_token\n,gmail,cid,csec,rtok\n';
    const rows = parseInboxBatchCsv(csv);
    expect(rows).toEqual([
      {
        email: '',
        provider: 'gmail',
        __malformed: true,
        __reason: expect.stringContaining('email'),
      },
    ]);
  });

  it('handles CRLF line endings', () => {
    const csv =
      'email,provider,client_id,client_secret,refresh_token\r\n' +
      'a@domain.com,gmail,cid,csec,rtok\r\n';
    const rows = parseInboxBatchCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'a@domain.com', provider: 'gmail' });
  });

  it('returns an empty array for a CSV with only a header', () => {
    const csv = 'email,provider,client_id,client_secret,refresh_token\n';
    const rows = parseInboxBatchCsv(csv);
    expect(rows).toEqual([]);
  });
});
