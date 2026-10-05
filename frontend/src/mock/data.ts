/**
 * Sample data for the preview screens. Nothing here comes from the backend.
 * Names, companies and addresses are invented.
 */

const day = (n: number) => new Date(Date.UTC(2026, 9, 3) - n * 86_400_000).toISOString().slice(5, 10);
export const DAYS = Array.from({ length: 14 }, (_, i) => day(13 - i));

/* ---------------- analytics ---------------- */

export const PERF_SERIES = {
  sent: [60, 74, 88, 92, 104, 118, 96, 70, 84, 112, 130, 128, 140, 152],
  opens: [26, 33, 38, 41, 47, 55, 42, 30, 38, 52, 61, 60, 68, 74],
  replies: [2, 3, 4, 4, 6, 7, 5, 3, 4, 7, 8, 8, 10, 11],
  bounces: [2, 1, 3, 2, 2, 4, 2, 1, 2, 3, 3, 2, 4, 3],
};

/* ---------------- resources ---------------- */
export const TEMPLATES = [
  { id: 'tp1', name: 'Cold intro · Product', subject: 'Quick question about {{company}}', body: 'Hi {{firstName}},\n\nI noticed {{company}} is hiring for growth roles, which usually means outbound is becoming a priority. We help teams like yours keep every sender in the inbox.\n\nWorth a 15-minute look?\n\n{{senderName}}', edited: '2d ago', variables: 4 },
  { id: 'tp2', name: 'Follow-up · Day 3', subject: 'Re: Quick question about {{company}}', body: 'Hi {{firstName}}, floating this back to the top of your inbox. Happy to send a two-line summary if that is easier.', edited: '4d ago', variables: 2 },
  { id: 'tp3', name: 'Breakup', subject: 'Should I close the loop?', body: 'Hi {{firstName}}, I will assume the timing is off and stop here. If it comes up later, reply to this thread and I will pick it up.', edited: '1w ago', variables: 1 },
  { id: 'tp4', name: 'Meeting confirmation', subject: 'Confirmed: {{meetingTitle}}', body: 'Thanks {{firstName}}, you are booked for {{meetingTime}}. The link is below.', edited: '2w ago', variables: 3 },
];

export const API_KEYS = [
  { id: 'k1', name: 'Zapier production', prefix: 'ew_live_8f3a…', scopes: 'inboxes:read, placement:write', last: '3 minutes ago', created: 'Aug 14', requests: 18420 },
  { id: 'k2', name: 'Internal dashboard', prefix: 'ew_live_c71d…', scopes: 'read-only', last: '2 hours ago', created: 'Sep 1', requests: 4210 },
  { id: 'k3', name: 'Staging test', prefix: 'ew_test_1b9e…', scopes: 'full access', last: 'Never used', created: 'Sep 28', requests: 0 },
];

export const AUDIT = [
  { id: 'au1', when: 'Oct 3, 09:41', user: 'Priya Raman', action: 'warmup.paused', entity: 'sales@acme-outbound.io', detail: 'status: warming → paused' },
  { id: 'au2', when: 'Oct 3, 09:12', user: 'Dev Okoro', action: 'placement.started', entity: 'hello@acme-outbound.io', detail: 'seeds: 24' },
  { id: 'au3', when: 'Oct 2, 17:30', user: 'You', action: 'mailbox.connected', entity: 'hello@acme-outbound.io', detail: 'provider: google' },
  { id: 'au4', when: 'Oct 2, 15:02', user: 'Sam Lee', action: 'pool.joined', entity: 'alex@acme-outbound.io', detail: 'consent recorded' },
  { id: 'au5', when: 'Oct 2, 10:48', user: 'Priya Raman', action: 'member.invited', entity: 'riley@acme-outbound.io', detail: 'role: member' },
  { id: 'au6', when: 'Oct 1, 14:20', user: 'You', action: 'apikey.created', entity: 'Staging test', detail: 'scope: full access' },
  { id: 'au7', when: 'Sep 30, 11:09', user: 'Dev Okoro', action: 'warmup.speed_changed', entity: 'hello@acme-outbound.io', detail: 'medium → slow' },
];

/* ---------------- deliverability / placement ---------------- */
export const DELIVERABILITY_SERIES = {
  inbox: [84, 86, 85, 88, 89, 87, 90, 91, 90, 92, 91, 93, 92, 94],
  spam: [6, 5, 6, 4, 4, 5, 3, 3, 3, 2, 3, 2, 2, 2],
};
export const AT_RISK = [
  { mailbox: 'hello@northwind.dev', issue: 'Bounce rate 4.1%', tone: 'bad' as const },
  { mailbox: 'founders@acme-outbound.io', issue: 'Spam placement 12%', tone: 'warn' as const },
];

export const PLACEMENT_TESTS = [
  { id: 'pt1', sender: 'alex@acme-outbound.io', subject: 'Quick question about Lumen', status: 'Complete', inbox: 9, spam: 1, missing: 0, started: 'Today 09:00' },
  { id: 'pt2', sender: 'sales@acme-outbound.io', subject: 'A resource for Sarah', status: 'Complete', inbox: 8, spam: 1, missing: 1, started: 'Yesterday' },
  { id: 'pt3', sender: 'hello@northwind.dev', subject: 'Re: pricing', status: 'Running', inbox: 3, spam: 0, missing: 0, started: '4 min ago' },
  { id: 'pt4', sender: 'founders@acme-outbound.io', subject: 'Should I close the loop?', status: 'Complete', inbox: 6, spam: 3, missing: 1, started: 'Sep 30' },
];
export const PLACEMENT_BATCHES = [
  { id: 'pb1', name: 'Weekly mailbox sweep', tests: 12, inboxRate: 91, started: 'Oct 1' },
  { id: 'pb2', name: 'New domains check', tests: 4, inboxRate: 78, started: 'Sep 24' },
];
export const SEED_PROVIDERS = [
  { provider: 'Gmail', inbox: 5, spam: 0, missing: 0, tabs: 'Primary 4 · Promotions 1' },
  { provider: 'Outlook', inbox: 3, spam: 1, missing: 0, tabs: '—' },
  { provider: 'Yahoo', inbox: 1, spam: 0, missing: 1, tabs: '—' },
];

export const DOMAINS = [
  { id: 'dm1', domain: 'acme-outbound.io', mailboxes: 4, spf: true, dkim: true, dmarc: true, tracking: true, redirect: true },
  { id: 'dm2', domain: 'getacme.co', mailboxes: 3, spf: true, dkim: true, dmarc: false, tracking: true, redirect: false },
  { id: 'dm3', domain: 'northwind.dev', mailboxes: 2, spf: true, dkim: false, dmarc: false, tracking: false, redirect: false },
  { id: 'dm4', domain: 'try-acme.com', mailboxes: 1, spf: false, dkim: false, dmarc: false, tracking: false, redirect: false },
];

/* ---------------- settings ---------------- */
export const MEMBERS = [
  { id: 'u1', name: 'Alex Morgan', email: 'alex@acme-outbound.io', role: 'Owner', joined: 'Jun 2' },
  { id: 'u2', name: 'Priya Raman', email: 'priya@acme-outbound.io', role: 'Admin', joined: 'Jun 9' },
  { id: 'u3', name: 'Dev Okoro', email: 'dev@acme-outbound.io', role: 'Member', joined: 'Jul 15' },
  { id: 'u4', name: 'Sam Lee', email: 'sam@acme-outbound.io', role: 'Member', joined: 'Aug 3' },
];
export const INVITES = [{ id: 'iv1', email: 'riley@acme-outbound.io', role: 'Member', expires: 'in 6 days' }];
export const TEAMS = [
  { id: 'tm1', name: 'Sales', color: 'bg-brand-500', members: ['Priya Raman', 'Dev Okoro'] },
  { id: 'tm2', name: 'Founders', color: 'bg-violet-500', members: ['Alex Morgan'] },
  { id: 'tm3', name: 'Support', color: 'bg-sky-500', members: ['Sam Lee'] },
];
export const ROLE_MATRIX = [
  { area: 'View warm-up analytics', owner: true, admin: true, member: true, viewer: true },
  { area: 'Start, pause and tune warm-up', owner: true, admin: true, member: true, viewer: false },
  { area: 'Connect and remove mailboxes', owner: true, admin: true, member: false, viewer: false },
  { area: 'Manage members and teams', owner: true, admin: true, member: false, viewer: false },
  { area: 'View audit log', owner: true, admin: true, member: false, viewer: false },
  { area: 'Billing and plan', owner: true, admin: false, member: false, viewer: false },
  { area: 'Delete the workspace', owner: true, admin: false, member: false, viewer: false },
];
export const WEBHOOKS = [
  { id: 'w1', url: 'https://hooks.acme-outbound.io/emailwarm', events: 'reply.received, mailbox.paused', state: 'Verified', lastOk: '4 min ago', failures: 0 },
  { id: 'w2', url: 'https://n8n.internal.dev/webhook/warm', events: 'All events', state: 'Auto-disabled', lastOk: '3 days ago', failures: 12 },
];
export const SESSIONS = [
  { id: 'ss1', device: 'Chrome on macOS', where: 'Bengaluru, IN', last: 'Active now', current: true },
  { id: 'ss2', device: 'Safari on iPhone', where: 'Bengaluru, IN', last: '2 hours ago', current: false },
  { id: 'ss3', device: 'Firefox on Windows', where: 'London, UK', last: '5 days ago', current: false },
];
export const INVOICES = [
  { id: 'in1', date: 'Oct 1, 2026', amount: '$99.00', status: 'Paid' },
  { id: 'in2', date: 'Sep 1, 2026', amount: '$99.00', status: 'Paid' },
  { id: 'in3', date: 'Aug 1, 2026', amount: '$99.00', status: 'Paid' },
];
export const USAGE = [
  { resource: 'Mailboxes', used: 14, limit: 20 },
  { resource: 'Warm-up pools joined', used: 3, limit: 10 },
  { resource: 'Contacts', used: 4820, limit: 10000 },
  { resource: 'Team members', used: 4, limit: 10 },
  { resource: 'Daily sends', used: 412, limit: 600 },
];
export const REFERRALS = [
  { id: 'r1', org: 'Fjord Systems', status: 'Rewarded', reward: '$25.00', date: 'Sep 18' },
  { id: 'r2', org: 'Kestrel', status: 'Qualified', reward: '$25.00', date: 'Sep 29' },
  { id: 'r3', org: 'Quanta', status: 'Pending', reward: '—', date: 'Oct 2' },
];
