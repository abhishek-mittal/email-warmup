import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  plan: text('plan').notNull().default('trial'),
  trialEndsAt: timestamp('trial_ends_at'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubId: text('stripe_sub_id'),
  slackWebhookUrl: text('slack_webhook_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inboxes = pgTable('inboxes', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  email: text('email').notNull(),
  provider: text('provider').notNull(),
  oauthProvider: text('oauth_provider'),
  oauthAccessToken: text('oauth_access_token'),
  oauthRefreshToken: text('oauth_refresh_token'),
  oauthTokenExpiry: timestamp('oauth_token_expiry'),
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port'),
  smtpUser: text('smtp_user'),
  smtpPass: text('smtp_pass'),
  imapHost: text('imap_host'),
  imapPort: integer('imap_port'),
  imapUser: text('imap_user'),
  imapPass: text('imap_pass'),
  dkimSelector: text('dkim_selector'),
  sendingIp: text('sending_ip'),
  warmupSpeed: text('warmup_speed').default('medium'),
  warmupDay: integer('warmup_day').default(0),
  status: text('status').notNull().default('pending'),
  poolConsentAt: timestamp('pool_consent_at'),
  enrolledInPoolAt: timestamp('enrolled_in_pool_at'),
  graduatedAt: timestamp('graduated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const poolMembers = pgTable(
  'pool_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id),
    email: text('email').notNull(),
    domain: text('domain').notNull(),
    provider: text('provider').notNull(),
    industry: text('industry'),
    reputation: integer('reputation').default(50),
    active: boolean('active').default(true),
    quarantined: boolean('quarantined').default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    domainIdx: index('pool_members_domain_idx').on(t.domain),
    providerIdx: index('pool_members_provider_idx').on(t.provider),
  }),
);

export const warmupSends = pgTable(
  'warmup_sends',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    senderInboxId: uuid('sender_inbox_id')
      .notNull()
      .references(() => inboxes.id),
    receiverInboxId: uuid('receiver_inbox_id')
      .notNull()
      .references(() => inboxes.id),
    messageId: text('message_id'),
    subject: text('subject'),
    bodyHash: text('body_hash'),
    warmupDay: integer('warmup_day').notNull(),
    scheduledAt: timestamp('scheduled_at').notNull(),
    sentAt: timestamp('sent_at'),
    openedAt: timestamp('opened_at'),
    repliedAt: timestamp('replied_at'),
    starredAt: timestamp('starred_at'),
    rescuedAt: timestamp('rescued_at'),
    filedAt: timestamp('filed_at'),
    landedInSpam: boolean('landed_in_spam').default(false),
    landedInTab: text('landed_in_tab'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    senderIdx: index('warmup_sends_sender_inbox_id_idx').on(t.senderInboxId),
    createdAtIdx: index('warmup_sends_created_at_idx').on(t.createdAt),
  }),
);

export const dnsChecks = pgTable('dns_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  inboxId: uuid('inbox_id')
    .notNull()
    .references(() => inboxes.id),
  spfValid: boolean('spf_valid'),
  spfRecord: text('spf_record'),
  dkimValid: boolean('dkim_valid'),
  dkimSelector: text('dkim_selector'),
  dmarcValid: boolean('dmarc_valid'),
  dmarcRecord: text('dmarc_record'),
  mxValid: boolean('mx_valid'),
  mxRecords: text('mx_records').array(),
  rdnsValid: boolean('rdns_valid'),
  rdnsValue: text('rdns_value'),
  score: integer('score'),
  checkedAt: timestamp('checked_at').defaultNow().notNull(),
});

export const blacklistChecks = pgTable('blacklist_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  inboxId: uuid('inbox_id')
    .notNull()
    .references(() => inboxes.id),
  isClean: boolean('is_clean'),
  listedCount: integer('listed_count'),
  rblResults: jsonb('rbl_results'),
  checkedAt: timestamp('checked_at').defaultNow().notNull(),
});

export const placementTests = pgTable(
  'placement_tests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id),
    seedCount: integer('seed_count'),
    primaryCount: integer('primary_count'),
    promotionsCount: integer('promotions_count'),
    spamCount: integer('spam_count'),
    missingCount: integer('missing_count'),
    primaryPct: integer('primary_pct'),
    promotionsPct: integer('promotions_pct'),
    spamPct: integer('spam_pct'),
    placementScore: integer('placement_score'),
    completedAt: timestamp('completed_at').defaultNow().notNull(),
  },
  (t) => ({
    inboxIdx: index('placement_tests_inbox_id_idx').on(t.inboxId),
  }),
);

export const seedInboxes = pgTable('seed_inboxes', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  provider: text('provider').notNull(), // 'gmail' | 'outlook' | 'yahoo'
  imapHost: text('imap_host').notNull(),
  imapPort: integer('imap_port').notNull(),
  imapUser: text('imap_user').notNull(),
  imapPass: text('imap_pass').notNull(), // encrypted via common/crypto.ts encrypt()
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const reputationScores = pgTable(
  'reputation_scores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id),
    score: integer('score').notNull(),
    dnsScore: integer('dns_score').notNull(),
    blacklistScore: integer('blacklist_score').notNull(),
    placementScore: integer('placement_score').notNull(),
    trend: text('trend'),
    recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  },
  (t) => ({
    inboxRecordedIdx: index('reputation_scores_inbox_recorded_idx').on(t.inboxId, t.recordedAt),
  }),
);

export const diagnostics = pgTable('diagnostics', {
  id: uuid('id').defaultRandom().primaryKey(),
  inboxId: uuid('inbox_id')
    .notNull()
    .references(() => inboxes.id),
  triggerType: text('trigger_type').notNull(),
  issueCodes: jsonb('issue_codes'),
  aiAnalysis: jsonb('ai_analysis'),
  readinessReport: jsonb('readiness_report'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  inboxId: uuid('inbox_id').references(() => inboxes.id),
  type: text('type').notNull(),
  channel: text('channel').notNull(),
  payload: jsonb('payload'),
  sentAt: timestamp('sent_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
