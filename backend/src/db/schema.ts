import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
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
  // Per-row OAuth app credentials supplied by the user for a batch-imported
  // inbox (T020). Distinct from the platform's GOOGLE_CLIENT_ID/
  // MICROSOFT_CLIENT_ID env vars used by the interactive OAuth connect flow.
  // clientId is not a secret (plaintext, like smtpUser/imapUser); clientSecret
  // is encrypted (like oauthAccessToken/oauthRefreshToken/smtpPass/imapPass).
  oauthClientId: text('oauth_client_id'),
  oauthClientSecret: text('oauth_client_secret'),
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
  // Why the inbox is not warming, when status is 'paused' or 'error':
  // 'user' | 'credentials_revoked' | 'transport_failed' | 'blacklist' | ...
  // A system reason is never cleared by a plain user resume.
  statusReason: text('status_reason'),
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

// Tenant-owned private pool. These are inboxes the tenant controls that act as
// the other side of all warmup conversations. They are never warmed themselves
// — they only send, receive, open, reply, and rescue.
export const poolInboxes = pgTable(
  'pool_inboxes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    provider: text('provider').notNull(), // 'gmail' | 'outlook' | 'custom'
    status: text('status').notNull().default('pending'), // 'pending' | 'active' | 'error'
    displayName: text('display_name'),
    encryptedCredentials: jsonb('encrypted_credentials').notNull(), // same AES-256-GCM structure as inboxes table
    lastUsedAt: timestamp('last_used_at'),
    activePairs: integer('active_pairs').notNull().default(0), // count of inboxes currently paired with this pool inbox
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_pool_inboxes_user_id').on(t.userId),
    statusIdx: index('idx_pool_inboxes_status').on(t.status),
    emailIdx: uniqueIndex('idx_pool_inboxes_email').on(t.email),
  }),
);

export const warmupSends = pgTable(
  'warmup_sends',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    senderInboxId: uuid('sender_inbox_id')
      .notNull()
      .references(() => inboxes.id),
    receiverInboxId: uuid('receiver_inbox_id').references(() => inboxes.id),
    // Set when the receiver is a private pool inbox (pool_inboxes.id) instead of
    // a warmed inbox (inboxes.id). No FK — pool_inboxes doesn't need a hard
    // reference here. Application-level invariant (enforced in T022, not by a
    // DB constraint): exactly one of receiverInboxId / receiverPoolInboxId is set.
    receiverPoolInboxId: uuid('receiver_pool_inbox_id'),
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
    // Delivery ledger (MR-02). A row is written BEFORE SMTP submission so a
    // crash can never leave an accepted message without a record.
    //   planned    — reserved by the scheduler, not yet attempted
    //   submitting — claimed by a worker; SMTP conversation in progress
    //   accepted   — the receiving server acknowledged the message
    //   uncertain  — submission may or may not have happened; never blindly resent
    //   failed     — definitely not delivered (rejected / never reached DATA)
    //   canceled   — reservation released (pause, lost eligibility, expired slot)
    // Rows created before this column existed were only ever inserted after a
    // successful send, hence the 'accepted' default.
    status: text('status').notNull().default('accepted'),
    // Logical delivery identity: '<scheduleId>:<slotIndex>' for scheduled sends.
    deliveryKey: text('delivery_key'),
    scheduleId: uuid('schedule_id'),
    slotIndex: integer('slot_index'),
    // When a worker claimed the row for submission (status -> submitting).
    claimedAt: timestamp('claimed_at'),
    smtpResponse: text('smtp_response'),
    failureReason: text('failure_reason'),
    // Set once the warmup-receive job for this send is on the queue. Accepted
    // rows with this still null are re-published by the recovery sweep.
    receiveEnqueuedAt: timestamp('receive_enqueued_at'),
    // Reply ledger. replyMessageId is deterministic per send and written
    // before the reply is submitted; replyStatus follows the same
    // submitting/accepted/uncertain/failed meaning as `status`.
    replyMessageId: text('reply_message_id'),
    replyStatus: text('reply_status'),
    replyFiledAt: timestamp('reply_filed_at'),
    // Delivery failure evidence (MR-12). Set at most once per send, either
    // from a permanent rejection at submission or from a delivery status
    // notification that names this message. 'hard' counts toward the bounce
    // rate; 'soft' (temporary) is recorded but does not.
    bouncedAt: timestamp('bounced_at'),
    bounceType: text('bounce_type'),
    bounceDetail: text('bounce_detail'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    senderIdx: index('warmup_sends_sender_inbox_id_idx').on(t.senderInboxId),
    createdAtIdx: index('warmup_sends_created_at_idx').on(t.createdAt),
    messageIdUq: uniqueIndex('warmup_sends_message_id_uq').on(t.messageId),
    deliveryKeyUq: uniqueIndex('warmup_sends_delivery_key_uq').on(t.deliveryKey),
    scheduleSlotUq: uniqueIndex('warmup_sends_schedule_slot_uq').on(t.scheduleId, t.slotIndex),
    receiverIdx: index('warmup_sends_receiver_inbox_id_idx').on(t.receiverInboxId),
    receiverPoolIdx: index('warmup_sends_receiver_pool_inbox_id_idx').on(t.receiverPoolInboxId),
  }),
);

// Pending mailbox-linking attempts (MR-01). Only a hash of the state value is
// stored; the row binds it to the user who started the flow, the provider and
// a short expiry, and is consumed exactly once by the callback.
export const oauthLinkStates = pgTable(
  'oauth_link_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    stateHash: text('state_hash').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider').notNull(), // 'gmail' | 'outlook'
    codeVerifier: text('code_verifier').notNull(), // PKCE verifier, encrypted
    poolConsent: boolean('pool_consent').notNull().default(false),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    stateHashUq: uniqueIndex('oauth_link_states_state_hash_uq').on(t.stateHash),
  }),
);

// Operator stop switches (MR-12). A row with cleared_at null halts new
// warmup submissions for its scope: everything ('global'), one mail provider
// ('provider', key = gmail|outlook|custom) or one account ('user', key = user
// id). Rows are never deleted, so the table doubles as the audit trail.
export const safetyStops = pgTable(
  'safety_stops',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scope: text('scope').notNull(),
    key: text('key').notNull().default('*'),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    clearedBy: text('cleared_by'),
    clearedAt: timestamp('cleared_at'),
  },
  (t) => ({
    activeIdx: index('safety_stops_scope_key_idx').on(t.scope, t.key),
  }),
);

// One row per inbox per UTC calendar day (MR-03). Creating the row is what
// advances warmup_day, so repeated cron runs / resume clicks / replicas can
// never schedule a second full day of volume or skip a ramp day.
export const warmupSchedules = pgTable(
  'warmup_schedules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id),
    scheduleDate: text('schedule_date').notNull(), // 'YYYY-MM-DD' in UTC
    policyVersion: integer('policy_version').notNull().default(1),
    warmupDay: integer('warmup_day').notNull(),
    plannedVolume: integer('planned_volume').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    inboxDateUq: uniqueIndex('warmup_schedules_inbox_date_policy_uq').on(
      t.inboxId,
      t.scheduleDate,
      t.policyVersion,
    ),
  }),
);

// Result of the initial health analysis that runs automatically when any
// inbox (to-warm or pool) is added. Exactly one of inboxId / poolInboxId is
// set (no DB constraint — pool inboxes have no inboxes.id and vice versa).
export const inboxAnalysis = pgTable(
  'inbox_analysis',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inboxId: uuid('inbox_id'), // references inboxes.id (nullable — pool inboxes have no inboxes.id)
    poolInboxId: uuid('pool_inbox_id'), // references pool_inboxes.id (nullable — only set for pool inboxes)
    spfValid: boolean('spf_valid'),
    dkimValid: boolean('dkim_valid'),
    dmarcValid: boolean('dmarc_valid'),
    mxValid: boolean('mx_valid'),
    rdnsValid: boolean('rdns_valid'),
    placementEstimate: text('placement_estimate'), // 'inbox' | 'promotions' | 'spam' | 'unknown'
    healthScore: integer('health_score'), // 0-100 composite of DNS fields
    issues: text('issues').array(), // array of issue code strings
    analysedAt: timestamp('analysed_at').defaultNow().notNull(),
  },
  (t) => ({
    inboxIdIdx: index('idx_inbox_analysis_inbox_id').on(t.inboxId),
    poolInboxIdIdx: index('idx_inbox_analysis_pool_inbox_id').on(t.poolInboxId),
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
    // Null until the test finishes. Rows written before `status` existed kept
    // an insert-time placeholder here; they are treated as complete.
    completedAt: timestamp('completed_at'),
    // queued -> running -> complete | partial | failed (MR-05).
    //   complete: every selected seed gave an observation
    //   partial:  some seeds could not be observed; percentages cover the rest
    //   failed:   too few observations to say anything; no percentages
    status: text('status').notNull().default('complete'),
    messageId: text('message_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    startedAt: timestamp('started_at'),
    // Seeds that yielded a real observation: the denominator of every percentage.
    observedCount: integer('observed_count'),
    // Delivered to the inbox but in a category other than Primary/Promotions.
    otherInboxCount: integer('other_inbox_count'),
    // Seeds that could not be observed (sign-in failure, timeout, seed gone).
    errorCount: integer('error_count'),
    failureReason: text('failure_reason'),
    // 'manual' (uses the monthly allowance) or 'graduation' (one free test
    // per inbox, run automatically when it is otherwise ready to graduate).
    purpose: text('purpose').notNull().default('manual'),
  },
  (t) => ({
    inboxIdx: index('placement_tests_inbox_id_idx').on(t.inboxId),
  }),
);

// One row per seed selected for a placement test, written when the test is
// created so the denominator cannot shrink if a seed is later removed.
export const placementResults = pgTable(
  'placement_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    testId: uuid('test_id')
      .notNull()
      .references(() => placementTests.id),
    seedInboxId: uuid('seed_inbox_id').notNull(),
    seedEmail: text('seed_email').notNull(),
    provider: text('provider').notNull(),
    // pending | primary | promotions | other_inbox | spam | not_found   (observations)
    // smtp_rejected | auth_error | timeout | seed_unavailable | error   (no observation)
    outcome: text('outcome').notNull().default('pending'),
    detail: text('detail'),
    observedAt: timestamp('observed_at'),
  },
  (t) => ({
    testSeedUq: uniqueIndex('placement_results_test_seed_uq').on(t.testId, t.seedInboxId),
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
  // Health (MR-14). A seed whose sign-in fails is quarantined and not used
  // for tests until a health check succeeds again.
  lastCheckedAt: timestamp('last_checked_at'),
  lastOkAt: timestamp('last_ok_at'),
  lastError: text('last_error'),
  quarantinedAt: timestamp('quarantined_at'),
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
    // How much of the score rests on real, recent measurements (0-100).
    // Null on rows written before this column existed.
    completeness: integer('completeness'),
    ruleVersion: integer('rule_version'),
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

export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(), // the Stripe event id, e.g. 'evt_...'
  processedAt: timestamp('processed_at').defaultNow().notNull(),
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
