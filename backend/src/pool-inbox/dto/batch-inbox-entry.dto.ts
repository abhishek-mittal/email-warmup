import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Per-entry shape for both `POST /inboxes/batch` and `POST /pool-inboxes/batch`
 * (T020). Shared between the inbox module and the pool-inbox module — both
 * controllers validate against this same DTO so the JSON batch endpoints and
 * the CSV batch endpoints (which funnel parsed rows through the same
 * per-row processing) stay in lockstep.
 *
 * Discriminated by `provider`:
 *   - 'gmail' | 'outlook' → clientId/clientSecret/refreshToken required
 *   - 'custom'            → smtp/imap fields required
 *
 * Validation here is structural only (right fields present for the
 * provider). It does NOT verify the credentials actually work — that's the
 * job of the (out-of-scope-for-T020) inbox-analysis job enqueued after
 * insert.
 */
export class BatchInboxEntryDto {
  @IsEmail()
  email: string;

  @IsIn(['gmail', 'outlook', 'custom'])
  provider: 'gmail' | 'outlook' | 'custom';

  // ---- gmail / outlook (OAuth, user-supplied app credentials) ----
  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'gmail' || o.provider === 'outlook')
  @IsString()
  @IsNotEmpty()
  clientId?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'gmail' || o.provider === 'outlook')
  @IsString()
  @IsNotEmpty()
  clientSecret?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'gmail' || o.provider === 'outlook')
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;

  // ---- custom (SMTP/IMAP) ----
  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsString()
  @IsNotEmpty()
  smtpHost?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsInt()
  @Type(() => Number)
  smtpPort?: number;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsString()
  @IsNotEmpty()
  smtpUser?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsString()
  @IsNotEmpty()
  smtpPassword?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsString()
  @IsNotEmpty()
  imapHost?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsInt()
  @Type(() => Number)
  imapPort?: number;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsString()
  @IsNotEmpty()
  imapUser?: string;

  @ValidateIf((o: BatchInboxEntryDto) => o.provider === 'custom')
  @IsString()
  @IsNotEmpty()
  imapPassword?: string;
}

export class BatchUploadDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchInboxEntryDto)
  inboxes: BatchInboxEntryDto[];
}
