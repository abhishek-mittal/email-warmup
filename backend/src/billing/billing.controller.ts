import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { count, eq } from 'drizzle-orm';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { db } from '../db';
import { users, inboxes } from '../db/schema';
import { BillingService, PLAN_LIMITS } from './billing.service';

/**
 * Surface for Stripe checkout, billing-portal, and self-service status.
 * Mirrors the @Req() req.userId pattern from scoring/diagnostics/inbox
 * controllers (BetterAuthGuard populates req.userId; see BetterAuthGuard).
 */
@Controller('billing')
@UseGuards(BetterAuthGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  async checkout(
    @Req() req: Request & { userId?: string },
    @Body() body: { plan: string },
  ): Promise<{ url: string }> {
    return this.billingService.createCheckoutSession(req.userId as string, body.plan);
  }

  @Post('portal')
  async portal(@Req() req: Request & { userId?: string }): Promise<{ url: string }> {
    return this.billingService.createPortalSession(req.userId as string);
  }

  /**
   * Self-serve status: current plan, trial countdown, inboxes-used-vs-limit,
   * and a portal URL (null when the user has no Stripe customer yet — never
   * throws in that case so trial users can still poll this endpoint).
   */
  @Get('status')
  async status(@Req() req: Request & { userId?: string }): Promise<{
    plan: string;
    trialEndsAt: string | null;
    inboxesUsed: number;
    inboxLimit: number;
    billingPortalUrl: string | null;
  }> {
    const userId = req.userId as string;

    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];
    if (!user) {
      // Behave consistently with other endpoints: a missing user is a 403-ish
      // situation, but we keep the response shape so the frontend can render
      // an empty state without a special-case.
      return {
        plan: 'free',
        trialEndsAt: null,
        inboxesUsed: 0,
        inboxLimit: PLAN_LIMITS.free.inboxes,
        billingPortalUrl: null,
      };
    }

    const [countRow] = await db
      .select({ count: count() })
      .from(inboxes)
      .where(eq(inboxes.userId, userId));

    const inboxesUsed = countRow?.count ?? 0;
    const inboxLimit = PLAN_LIMITS[user.plan]?.inboxes ?? 0;

    // Only attempt a portal session when we actually have a Stripe customer;
    // createPortalSession throws BadRequestException otherwise, and we
    // explicitly don't want trial/free users to see an error here.
    let billingPortalUrl: string | null = null;
    if (user.stripeCustomerId) {
      try {
        const portal = await this.billingService.createPortalSession(userId);
        billingPortalUrl = portal.url;
      } catch {
        billingPortalUrl = null;
      }
    }

    return {
      plan: user.plan,
      trialEndsAt: user.trialEndsAt ? user.trialEndsAt.toISOString() : null,
      inboxesUsed,
      inboxLimit,
      billingPortalUrl,
    };
  }
}
