import { PayloadTooLargeException } from '@nestjs/common';

/** Largest CSV accepted for a mailbox import. Enforced while the upload is read. */
export const MAX_IMPORT_BYTES = 1024 * 1024;
/** Most mailboxes accepted in one import request (CSV or JSON). */
export const MAX_IMPORT_ROWS = 200;

export function assertImportSize(rows: number): void {
  if (rows > MAX_IMPORT_ROWS) {
    throw new PayloadTooLargeException(
      `An import can contain at most ${MAX_IMPORT_ROWS} mailboxes; this one has ${rows}. Split it into smaller files.`,
    );
  }
}
