/**
 * Hand-rolled CSV parser for the inbox batch-upload endpoints (T020). No new
 * npm dependency — the documented columns are simple values with no embedded
 * commas or quotes, so a line/comma splitter is sufficient.
 *
 * Expected columns (header row, any case/whitespace around values ok):
 *   Gmail/Outlook: email, provider, client_id, client_secret, refresh_token
 *   Custom:        email, provider, smtp_host, smtp_port, smtp_user,
 *                  smtp_password, imap_host, imap_port, imap_user, imap_password
 *
 * Mixed providers in one file are supported — detection is per-row by the
 * `provider` column value. A row missing required fields for its provider
 * (or with an unrecognized provider) is returned as a `MalformedCsvRow`
 * instead of throwing, so the caller can route it straight into a batch
 * `failed[]` entry without aborting the rest of the file.
 *
 * Never persists the raw CSV — this module only operates on an in-memory
 * string and returns parsed JS objects.
 */

export interface OAuthBatchEntry {
  email: string;
  provider: 'gmail' | 'outlook';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface CustomBatchEntry {
  email: string;
  provider: 'custom';
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
}

export interface MalformedCsvRow {
  email: string;
  provider: string;
  __malformed: true;
  __reason: string;
}

export type ParsedCsvRow = OAuthBatchEntry | CustomBatchEntry | MalformedCsvRow;

const OAUTH_PROVIDERS = new Set(['gmail', 'outlook']);

export function parseInboxBatchCsv(csv: string): ParsedCsvRow[] {
  const lines = csv.split(/\r\n|\n|\r/);
  if (lines.length === 0) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const colIndex = (name: string) => header.indexOf(name);

  const rows: ParsedCsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // skip blank rows

    const cells = line.split(',').map((c) => c.trim());
    const get = (name: string): string => {
      const idx = colIndex(name);
      return idx === -1 ? '' : (cells[idx] ?? '');
    };

    const email = get('email');
    const provider = get('provider').toLowerCase();

    if (!email) {
      rows.push({ email, provider, __malformed: true, __reason: 'email is required' });
      continue;
    }

    if (OAUTH_PROVIDERS.has(provider)) {
      const clientId = get('client_id');
      const clientSecret = get('client_secret');
      const refreshToken = get('refresh_token');
      const missing: string[] = [];
      if (!clientId) missing.push('client_id');
      if (!clientSecret) missing.push('client_secret');
      if (!refreshToken) missing.push('refresh_token');
      if (missing.length > 0) {
        rows.push({
          email,
          provider,
          __malformed: true,
          __reason: `missing required field(s): ${missing.join(', ')}`,
        });
        continue;
      }
      rows.push({
        email,
        provider: provider as 'gmail' | 'outlook',
        clientId,
        clientSecret,
        refreshToken,
      });
      continue;
    }

    if (provider === 'custom') {
      const smtpHost = get('smtp_host');
      const smtpPortRaw = get('smtp_port');
      const smtpUser = get('smtp_user');
      const smtpPassword = get('smtp_password');
      const imapHost = get('imap_host');
      const imapPortRaw = get('imap_port');
      const imapUser = get('imap_user');
      const imapPassword = get('imap_password');

      const missing: string[] = [];
      if (!smtpHost) missing.push('smtp_host');
      if (!smtpPortRaw) missing.push('smtp_port');
      if (!smtpUser) missing.push('smtp_user');
      if (!smtpPassword) missing.push('smtp_password');
      if (!imapHost) missing.push('imap_host');
      if (!imapPortRaw) missing.push('imap_port');
      if (!imapUser) missing.push('imap_user');
      if (!imapPassword) missing.push('imap_password');

      if (missing.length > 0) {
        rows.push({
          email,
          provider,
          __malformed: true,
          __reason: `missing required field(s): ${missing.join(', ')}`,
        });
        continue;
      }

      const smtpPort = Number(smtpPortRaw);
      const imapPort = Number(imapPortRaw);
      if (!Number.isFinite(smtpPort) || !Number.isFinite(imapPort)) {
        rows.push({
          email,
          provider,
          __malformed: true,
          __reason: 'smtp_port and imap_port must be numeric',
        });
        continue;
      }

      rows.push({
        email,
        provider: 'custom',
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPassword,
        imapHost,
        imapPort,
        imapUser,
        imapPassword,
      });
      continue;
    }

    rows.push({
      email,
      provider,
      __malformed: true,
      __reason: `unrecognized provider: '${provider}' (expected gmail, outlook, or custom)`,
    });
  }

  return rows;
}

export function isMalformedCsvRow(row: ParsedCsvRow): row is MalformedCsvRow {
  return (row as MalformedCsvRow).__malformed === true;
}
