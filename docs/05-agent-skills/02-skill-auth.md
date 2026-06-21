# Skill: Auth (Clerk + JWT)

**Domain:** Clerk authentication, JWT validation, NestJS auth guard, webhook sync  
**Load when:** Working on AuthModule, ClerkGuard, user sync, plan gating, webhook handlers

---

## Module structure

```
src/
├── auth/
│   ├── auth.module.ts
│   ├── clerk.guard.ts          ← NestJS guard: validates Clerk JWT on every request
│   ├── clerk-webhook.controller.ts  ← POST /webhooks/clerk (SVIX verified)
│   └── user-sync.service.ts    ← syncs Clerk user data into local users table
```

---

## Clerk JWT guard

```typescript
// clerk.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { verifyToken } from '@clerk/backend';

@Injectable()
export class ClerkGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractBearerToken(request);

    if (!token) throw new UnauthorizedException('Missing auth token');

    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      request.userId = payload.sub;  // Clerk user ID attached to request
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

function extractBearerToken(req: any): string | null {
  const auth = req.headers?.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}
```

### Applying the guard
```typescript
// Apply globally in main.ts
app.useGlobalGuards(new ClerkGuard());

// Or per-controller
@UseGuards(ClerkGuard)
@Controller('inboxes')
export class InboxController {}

// Skip auth on public routes
@Public()   // custom decorator that sets metadata
@Get('health')
healthCheck() { ... }
```

---

## Clerk webhook sync

Clerk fires webhooks when users are created/updated/deleted. We must keep the local `users` table in sync.

```typescript
// clerk-webhook.controller.ts

@Post('webhooks/clerk')
async handleClerkWebhook(@Req() req: RawBodyRequest, @Headers() headers: any) {
  // 1. Verify SVIX signature
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
  let event: WebhookEvent;
  try {
    event = wh.verify(req.rawBody, {
      'svix-id':        headers['svix-id'],
      'svix-timestamp': headers['svix-timestamp'],
      'svix-signature': headers['svix-signature'],
    }) as WebhookEvent;
  } catch {
    throw new BadRequestException('Invalid webhook signature');
  }

  // 2. Handle event types
  switch (event.type) {
    case 'user.created':
      await this.userSync.upsertUser({
        id:    event.data.id,
        email: event.data.email_addresses[0].email_address,
        plan:  'trial',
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      break;
    case 'user.updated':
      await this.userSync.updateEmail(event.data.id, event.data.email_addresses[0].email_address);
      break;
    case 'user.deleted':
      await this.userSync.softDeleteUser(event.data.id);
      break;
  }

  return { received: true };
}
```

**Critical:** NestJS must receive the raw body for SVIX signature verification.  
In `main.ts`: `app.use('/webhooks/clerk', rawBodyMiddleware)` before `json()` middleware.

---

## Plan entitlement check

```typescript
// Plan gate utility — use in any service to enforce plan limits
async assertPlan(userId: string, requiredPlan: string[]): Promise<void> {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user[0] || !requiredPlan.includes(user[0].plan)) {
    throw new ForbiddenException(`This feature requires plan: ${requiredPlan.join(' or ')}`);
  }
}

// Inbox count limit check
async assertInboxLimit(userId: string): Promise<void> {
  const user = await getUser(userId);
  const count = await countInboxes(userId);
  const limit = PLAN_LIMITS[user.plan].inboxes;
  if (count >= limit) {
    throw new ForbiddenException(`Inbox limit reached for ${user.plan} plan (${limit} inboxes)`);
  }
}

const PLAN_LIMITS = {
  trial:      { inboxes: 3  },
  starter:    { inboxes: 3  },
  growth:     { inboxes: 20 },
  agency:     { inboxes: 100 },
  enterprise: { inboxes: Infinity },
};
```

---

## Environment variables

```
CLERK_SECRET_KEY=sk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_WEBHOOK_SECRET=whsec_...
```

All three are required. Missing any will cause auth to fail at startup — validate in `ConfigModule` with Joi.

---

## What you never do

- **Never skip SVIX signature verification** — always verify before processing any webhook event
- **Never trust the `userId` claim in the request body** — always extract from the verified JWT payload via `request.userId`
- **Never store Clerk's JWT secret in code** — always from env var
- **Never allow plan checks to be bypassed** — `assertPlan()` must be called in the service layer, not just in the controller
- **Never receive Clerk webhooks without raw body middleware** — SVIX verification will fail on parsed JSON body
