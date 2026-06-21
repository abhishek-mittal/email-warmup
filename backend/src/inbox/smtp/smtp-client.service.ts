import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class SmtpClientService {
  async verify(inboxId: string): Promise<void> {
    const transporter = await this.getTransporter(inboxId);
    await transporter.verify();
  }

  async getTransporter(inboxId: string) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    if (inbox.provider === 'gmail' || inbox.provider === 'outlook') {
      return nodemailer.createTransport({
        host: inbox.smtpHost || 'smtp.gmail.com',
        port: inbox.smtpPort || 465,
        secure: true,
        auth: {
          type: 'OAuth2',
          user: inbox.email,
          accessToken: decrypt(inbox.oauthAccessToken!),
        },
      });
    }

    return nodemailer.createTransport({
      host: inbox.smtpHost!,
      port: inbox.smtpPort || 587,
      secure: (inbox.smtpPort || 587) === 465,
      auth: {
        user: inbox.smtpUser!,
        pass: decrypt(inbox.smtpPass!),
      },
    });
  }
}
