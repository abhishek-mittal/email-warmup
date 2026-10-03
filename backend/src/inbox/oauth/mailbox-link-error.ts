import { BadRequestException } from '@nestjs/common';

/** Stable, non-sensitive failure codes the frontend can show a message for. */
export type MailboxLinkErrorCode =
  | 'denied'
  | 'state_invalid'
  | 'provider_error'
  | 'duplicate'
  | 'limit'
  | 'connection_failed';

export class MailboxLinkError extends BadRequestException {
  constructor(
    readonly code: MailboxLinkErrorCode,
    message: string,
  ) {
    super({ code, message });
    this.name = 'MailboxLinkError';
  }
}
