/**
 * Slack Block Kit formatter for the `notify` queue's inbox-scoped alert
 * types. Per T017 context addendum #10: header + section + context blocks
 * always; an actions block ("View dashboard" button) only for the 4 truly
 * critical inbox alert types (dns_broken, blacklist_hit, score_drop,
 * token_revoked) — warmup_complete is a positive event with nothing urgent
 * to act on, so it gets no action button.
 *
 * Only inbox-scoped types are formattable here — trial_expired,
 * plan_activated, and payment_failed never reach this module (NotifyProcessor
 * gates Slack fan-out on `inboxId` presence per addendum #4).
 */

export type SlackAlertType =
  | 'dns_broken'
  | 'blacklist_hit'
  | 'score_drop'
  | 'token_revoked'
  | 'warmup_complete';

export interface SlackMessageInput {
  type: SlackAlertType;
  inboxEmail: string;
  inboxId: string;
  appUrl: string;
  payload: Record<string, any>;
}

export interface SlackBlock {
  type: string;
  [key: string]: any;
}

export interface SlackMessage {
  blocks: SlackBlock[];
}

const TYPES_WITH_ACTIONS: ReadonlySet<SlackAlertType> = new Set([
  'dns_broken',
  'blacklist_hit',
  'score_drop',
  'token_revoked',
]);

const HEADER_ICON: Record<SlackAlertType, string> = {
  dns_broken: '⚠️',
  blacklist_hit: '🚨',
  score_drop: '📉',
  token_revoked: '🔑',
  warmup_complete: '🎉',
};

const HEADER_TITLE: Record<SlackAlertType, string> = {
  dns_broken: 'DNS issue detected',
  blacklist_hit: 'Inbox blacklisted',
  score_drop: 'Reputation score dropped',
  token_revoked: 'Inbox disconnected',
  warmup_complete: 'Warmup complete',
};

function buildSectionText(input: SlackMessageInput): string {
  const { type, inboxEmail, payload } = input;

  switch (type) {
    case 'dns_broken': {
      const issueCodes: string[] = payload.issueCodes ?? [];
      return `*Inbox:* ${inboxEmail}\n*Broken records:* ${issueCodes.join(', ')}`;
    }
    case 'blacklist_hit': {
      const listed: string[] = payload.listed ?? [];
      return `*Inbox:* ${inboxEmail}\n*Listed on:* ${listed.join(', ')}`;
    }
    case 'score_drop': {
      const { prev, current, delta } = payload;
      return `*Inbox:* ${inboxEmail}\n*Score:* ${prev} → ${current} (-${delta})`;
    }
    case 'token_revoked':
      return `*Inbox:* ${inboxEmail}\n*Status:* OAuth connection revoked or expired`;
    case 'warmup_complete': {
      const volume = payload.recommendedDailySendVolume;
      return `*Inbox:* ${inboxEmail}\n*Recommended daily send volume:* ${volume}`;
    }
    default:
      return `*Inbox:* ${inboxEmail}`;
  }
}

export function formatSlackMessage(input: SlackMessageInput): SlackMessage {
  const { type, inboxId, appUrl } = input;
  const dashboardUrl = `${appUrl}/inboxes/${inboxId}`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${HEADER_ICON[type]} ${HEADER_TITLE[type]}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: buildSectionText(input),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${new Date().toISOString()} | <${dashboardUrl}|View in dashboard>`,
        },
      ],
    },
  ];

  if (TYPES_WITH_ACTIONS.has(type)) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View dashboard',
          },
          url: dashboardUrl,
        },
      ],
    });
  }

  return { blocks };
}
