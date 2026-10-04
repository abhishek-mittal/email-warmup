/**
 * Registry of every product area in the UI. Each entry is one decision the
 * owner can make: keep it, or hide it. Hidden features disappear from the
 * navigation, the command palette and the router (their pages show a
 * "hidden" notice instead of content).
 *
 * `real` features run against the backend. `stub` features are front-end
 * only, with sample data, and say so on the page.
 */
export type FeatureGroup = 'inbox' | 'email' | 'resources' | 'settings' | 'account' | 'shell';

export interface Feature {
  id: string;
  label: string;
  group: FeatureGroup;
  /** Main route; also the nav target. */
  href: string;
  description: string;
  kind: 'real' | 'stub';
  /** Show in the sidebar navigation. */
  nav?: boolean;
  /** Short label for the settings sidebar, when different. */
  settingsLabel?: string;
}

export const GROUP_LABELS: Record<FeatureGroup, string> = {
  inbox: 'Inbox',
  email: 'Email',
  resources: 'Resources',
  settings: 'Settings pages',
  account: 'Account and sign-in flows',
  shell: 'App chrome',
};

export const FEATURES: Feature[] = [
  // Real, already connected
  { id: 'inboxes', label: 'Inboxes', group: 'email', href: '/inboxes', kind: 'real', nav: true, description: 'Connect, warm and monitor mailboxes.' },
  { id: 'pool', label: 'Warming pool', group: 'email', href: '/pool', kind: 'real', nav: true, description: 'Your private pool of partner mailboxes.' },

  // Email
  { id: 'analytics', label: 'Analytics', group: 'email', href: '/analytics', kind: 'stub', nav: true, description: 'Workspace-wide performance, account health and top campaigns.' },
  { id: 'deliverability', label: 'Deliverability', group: 'email', href: '/deliverability', kind: 'stub', nav: true, description: 'Inbox placement, bounce and complaint health across mailboxes.' },
  { id: 'placement', label: 'Placement tests', group: 'email', href: '/placement', kind: 'stub', description: 'Seed-inbox placement tests and batches.' },
  { id: 'domains', label: 'Sending domains', group: 'email', href: '/inboxes/domains', kind: 'stub', description: 'Authentication, tracking and redirects per domain.' },


  // Resources
  { id: 'templates', label: 'Templates', group: 'resources', href: '/templates', kind: 'stub', nav: true, description: 'Reusable subject and body with variables.' },
  { id: 'api_keys', label: 'API keys', group: 'resources', href: '/api-keys', kind: 'stub', nav: true, description: 'Scoped tokens for the public API.' },
  { id: 'audit', label: 'Audit log', group: 'resources', href: '/audit', kind: 'stub', nav: true, description: 'Every change made in the workspace.' },

  // Settings
  { id: 's_profile', label: 'Profile', group: 'settings', href: '/settings/profile', kind: 'stub', description: 'Your name, email and undo window.' },
  { id: 's_workspace', label: 'Workspace', group: 'settings', href: '/settings/workspace', kind: 'stub', description: 'Workspace name, defaults and AI context.' },
  { id: 's_members', label: 'Members', group: 'settings', href: '/settings/members', kind: 'stub', description: 'People, invitations and roles.' },
  { id: 's_teams', label: 'Teams', group: 'settings', href: '/settings/teams', kind: 'stub', description: 'Groups of members for assignment.' },
  { id: 's_roles', label: 'Roles and access', group: 'settings', href: '/settings/roles', kind: 'stub', description: 'What each role can do.' },
  { id: 's_security', label: 'Security', group: 'settings', href: '/settings/security', kind: 'stub', description: 'Password, two-factor and sessions.' },
  { id: 's_notifications', label: 'Notifications', group: 'settings', href: '/settings/notifications', kind: 'stub', description: 'What you are told about, and where.' },
  { id: 's_sending', label: 'Sending', group: 'settings', href: '/settings/sending', kind: 'stub', description: 'Delivery hours, timezones and reply handling.' },
  { id: 's_billing', label: 'Billing', group: 'settings', href: '/settings/billing', kind: 'stub', description: 'Plans, payment method and invoices.' },
  { id: 's_limits', label: 'Plan and limits', group: 'settings', href: '/settings/limits', kind: 'stub', description: 'Usage and limit requests.' },
  { id: 's_referral', label: 'Refer and earn', group: 'settings', href: '/settings/referral', kind: 'stub', description: 'Referral link and credit.' },
  { id: 's_webhooks', label: 'Webhooks', group: 'settings', href: '/settings/webhooks', kind: 'stub', description: 'Signed event deliveries to your endpoints.' },
  { id: 's_data', label: 'Data export and import', group: 'settings', href: '/settings/data', kind: 'stub', description: 'Move a workspace between instances.' },
  { id: 's_danger', label: 'Danger zone', group: 'settings', href: '/settings/danger', kind: 'stub', description: 'Delete the workspace or your account.' },

  // Account flows
  { id: 'onboarding', label: 'Onboarding', group: 'account', href: '/onboarding', kind: 'stub', description: 'First-run welcome and workspace setup.' },
  { id: 'select_org', label: 'Workspace picker', group: 'account', href: '/select-org', kind: 'stub', description: 'Choose between workspaces.' },
  { id: 'invite', label: 'Accept invitation', group: 'account', href: '/invite', kind: 'stub', description: 'Join a workspace from an invite link.' },
  { id: 'login_verify', label: 'Sign-in code', group: 'account', href: '/sign-in/verify', kind: 'stub', description: 'Email one-time code step after sign-in.' },

  // Chrome
  { id: 'workspaces', label: 'Workspace switcher', group: 'shell', href: '/select-org', kind: 'stub', description: 'Workspace name and switcher in the top bar.' },
  { id: 'notif_bell', label: 'Notification bell', group: 'shell', href: '/', kind: 'stub', description: 'In-app notifications panel.' },
  { id: 'cmd_palette', label: 'Command palette', group: 'shell', href: '/', kind: 'stub', description: 'Search and jump anywhere with Cmd or Ctrl K.' },
  { id: 'presence', label: 'Teammate presence', group: 'shell', href: '/', kind: 'stub', description: 'Avatars of teammates active right now.' },
];

export const FEATURE_BY_ID: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.id, f]));
