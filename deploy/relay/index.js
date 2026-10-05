// Citadel mailer — a tiny SMTP server that relays messages to Microsoft 365
// via the Graph API (sendMail), reusing the same app registration + Mail.Send
// pattern as ironbeam's engine/src/notify/graph-email.ts. Microsoft killed
// basic SMTP auth for this tenant, so Graph is the only send path.
//
// Runs INTERNAL-ONLY on the compose network: no TLS, no SMTP auth. Never
// publish its port. Zitadel connects to it as a plain SMTP relay.
//
// Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (same as ironbeam). PORT optional.

import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
const PORT = Number(process.env.PORT || 2525);

for (const [k, v] of Object.entries({ MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET })) {
  if (!v) {
    console.error(`[relay] missing required env ${k}`);
    process.exit(1);
  }
}

const credential = new ClientSecretCredential(MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET);
const authProvider = new TokenCredentialAuthenticationProvider(credential, {
  scopes: ['https://graph.microsoft.com/.default'],
});
const graph = Client.initWithMiddleware({ authProvider });

const addrs = (field) => (field?.value || []).map((a) => ({ emailAddress: { address: a.address } }));

async function sendViaGraph(parsed) {
  const from = parsed.from?.value?.[0]?.address;
  const to = addrs(parsed.to);
  if (!from) throw new Error('message has no From address');
  if (to.length === 0) throw new Error('message has no To address');

  const message = {
    subject: parsed.subject || '',
    body: parsed.html
      ? { contentType: 'HTML', content: parsed.html }
      : { contentType: 'Text', content: parsed.text || '' },
    toRecipients: to,
    ...(addrs(parsed.cc).length ? { ccRecipients: addrs(parsed.cc) } : {}),
  };
  // Send AS the From mailbox; the Graph app must be permitted to send as it
  // (Application Access Policy scoped to am@webnco.xyz).
  await graph.api(`/users/${encodeURIComponent(from)}/sendMail`).post({ message, saveToSentItems: false });
}

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'], // internal-only: no auth, no TLS
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(sendViaGraph)
      .then(() => {
        console.log(`[relay] sent ok (session ${session.id})`);
        callback();
      })
      .catch((err) => {
        console.error(`[relay] send failed (session ${session.id}):`, err?.message || err);
        callback(new Error('relay: Graph send failed'));
      });
  },
});

server.on('error', (err) => console.error('[relay] server error:', err?.message || err));
server.listen(PORT, '0.0.0.0', () => console.log(`[relay] SMTP->Graph listening on :${PORT}`));
