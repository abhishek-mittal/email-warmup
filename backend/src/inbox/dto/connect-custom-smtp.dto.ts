import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsIn,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';

/**
 * DTO for `POST /inboxes/connect/smtp` (Custom SMTP connect).
 *
 * IMAP is **optional**. The user can connect a sending-only inbox (e.g. a
 * transactional SMTP relay that does not expose IMAP) and add IMAP later
 * from the inbox detail page. Without IMAP, the warmup engine still
 * sends via SMTP, but the receive/reply/rescue-from-spam/placement-test
 * paths gracefully no-op for that inbox. The inbox is enrolled in the
 * pool only if IMAP is configured (warmup requires being able to confirm
 * the email arrived).
 *
 * Field name aliases: the form sends `smtpPassword` / `imapPassword`
 * (user-friendly), the in-process / DB column names are `smtpPass` /
 * `imapPass` (matching Drizzle's snake_case mapping). The DTO accepts
 * BOTH names — `smtpPass` is canonical, `smtpPassword` is the form
 * alias. See `normalizeAliases` at the bottom of this file — it's a
 * wire-compat shim, not a permanent renaming.
 */

export class ConnectCustomSmtpDto {
  @IsEmail()
  email: string;

  // ---- SMTP (required) ----
  @IsString()
  @IsNotEmpty()
  smtpHost: string;

  @IsInt()
  @IsIn([25, 465, 587])
  smtpPort: number;

  @IsString()
  @IsNotEmpty()
  smtpUser: string;

  @IsString()
  @IsNotEmpty()
  smtpPass: string;

  // ---- IMAP (optional, all-or-nothing) ----
  @IsOptional()
  @IsBoolean()
  useImap?: boolean;

  @ValidateIf((o: ConnectCustomSmtpDto) => o.useImap === true)
  @IsString()
  @IsNotEmpty()
  imapHost?: string;

  @ValidateIf((o: ConnectCustomSmtpDto) => o.useImap === true)
  @IsInt()
  @IsIn([143, 993])
  imapPort?: number;

  @ValidateIf((o: ConnectCustomSmtpDto) => o.useImap === true)
  @IsString()
  @IsNotEmpty()
  imapUser?: string;

  @ValidateIf((o: ConnectCustomSmtpDto) => o.useImap === true)
  @IsString()
  @IsNotEmpty()
  imapPass?: string;

  // ---- Misc ----
  @IsString()
  @IsOptional()
  dkimSelector?: string;
}

/**
 * Wire-compat shim: when a request comes in with `smtpPassword` /
 * `imapPassword` (form names) instead of `smtpPass` / `imapPass`
 * (DB column names), copy the alias value into the canonical field
 * before class-validator runs.
 *
 * Use as:
 *
 *   const dto = normalizeAliases(requestBody);
 *   const errors = validateSync(dto);
 */
export function normalizeAliases(raw: Record<string, unknown>): ConnectCustomSmtpDto {
  const copy: Record<string, unknown> = { ...raw };
  // Copy the alias to the canonical field, then remove the alias so
  // class-validator's `forbidNonWhitelisted: true` doesn't reject it
  // as an unknown property.
  if (copy.smtpPass == null && copy.smtpPassword != null) {
    copy.smtpPass = copy.smtpPassword;
  }
  delete copy.smtpPassword;

  if (copy.imapPass == null && copy.imapPassword != null) {
    copy.imapPass = copy.imapPassword;
  }
  delete copy.imapPassword;

  return plainToInstance(ConnectCustomSmtpDto, copy);
}
