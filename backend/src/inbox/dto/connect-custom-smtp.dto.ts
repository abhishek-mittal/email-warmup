import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, IsIn, IsNotEmpty, ValidateIf } from 'class-validator';

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
  // When `useImap` is true, all four IMAP fields are required. When false,
  // they may be omitted (or sent as empty strings — the controller will
  // ignore them). We validate with ValidateIf so the user can't half-fill
  // the IMAP block.
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
