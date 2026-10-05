import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../../db';
import { oauthLinkStates } from '../../db/schema';
import { decrypt, encrypt } from '../../common/crypto';
import { GoogleOAuthService } from './google-oauth.service';
import { MicrosoftOAuthService } from './microsoft-oauth.service';
import { InboxService } from '../inbox.service';
import { MailboxLinkError } from './mailbox-link-error';

export { MailboxLinkError } from './mailbox-link-error';

export type LinkProvider = 'gmail' | 'outlook';

const STATE_TTL_MS = 5 * 60_000;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Mailbox OAuth linking (MR-01).
 *
 * The state value sent to the provider is 32 random bytes. Only its hash is
 * stored, in a row that names the signed-in user who started the flow, the
 * provider, and a five-minute expiry. The callback must be made by that same
 * signed-in user and consumes the row atomically, exactly once — so a state
 * that was edited, replayed, expired, started by someone else or for the
 * other provider is rejected before any token exchange. Nothing about who
 * the mailbox belongs to is ever read out of the state value itself.
 *
 * PKCE (S256) binds the authorization code to this flow as well.
 */
@Injectable()
export class MailboxLinkService {
  constructor(
    @InjectPinoLogger(MailboxLinkService.name)
    private readonly logger: PinoLogger,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly microsoftOAuth: MicrosoftOAuthService,
    private readonly inboxService: InboxService,
  ) {}

  async start(
    userId: string,
    provider: LinkProvider,
    opts: { poolConsent?: boolean } = {},
  ): Promise<{ url: string }> {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    await db.insert(oauthLinkStates).values({
      stateHash: sha256Hex(state),
      userId,
      provider,
      codeVerifier: encrypt(codeVerifier),
      poolConsent: opts.poolConsent === true,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    // Opportunistic cleanup; rows are tiny and short-lived.
    await db
      .delete(oauthLinkStates)
      .where(lt(oauthLinkStates.expiresAt, new Date(Date.now() - 24 * 60 * 60_000)));

    return { url: this.oauthService(provider).getAuthorizationUrl(state, codeChallenge) };
  }

  async complete(
    userId: string,
    provider: LinkProvider,
    params: { code?: string; state?: string; error?: string },
  ) {
    // Consume first, whatever else is wrong: a state value is single-use even
    // when the user declined or the provider reported an error.
    const pending = params.state ? await this.consume(userId, provider, params.state) : null;

    if (params.error) {
      this.logger.info({ userId, provider, providerError: params.error }, 'mailbox link declined');
      throw new MailboxLinkError('denied', 'Access to the mailbox was not granted.');
    }
    if (!pending || !params.code) {
      this.logger.warn({ userId, provider }, 'mailbox link rejected: invalid state');
      throw new MailboxLinkError(
        'state_invalid',
        'This connection attempt is no longer valid. Please start again.',
      );
    }

    let tokens: Awaited<ReturnType<GoogleOAuthService['exchangeCode']>>;
    try {
      tokens = await this.oauthService(provider).exchangeCode(
        params.code,
        decrypt(pending.codeVerifier),
      );
    } catch (err) {
      this.logger.warn(
        { userId, provider, err: (err as Error)?.message },
        'mailbox link failed: token exchange',
      );
      throw new MailboxLinkError(
        'provider_error',
        'The mail provider did not complete the connection. Please try again.',
      );
    }

    return this.inboxService.connectOAuthMailbox(userId, provider, tokens, {
      poolConsent: pending.poolConsent,
    });
  }

  /** Atomically claims an unexpired, unused state row for this user and provider. */
  private async consume(userId: string, provider: LinkProvider, state: string) {
    const rows = await db
      .update(oauthLinkStates)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(oauthLinkStates.stateHash, sha256Hex(state)),
          eq(oauthLinkStates.userId, userId),
          eq(oauthLinkStates.provider, provider),
          isNull(oauthLinkStates.consumedAt),
          gt(oauthLinkStates.expiresAt, new Date()),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  private oauthService(provider: LinkProvider) {
    return provider === 'gmail' ? this.googleOAuth : this.microsoftOAuth;
  }
}
