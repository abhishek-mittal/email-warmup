import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Pool } from 'pg';
import { getAuth } from '@/lib/auth-server';

// EmailWarm's own role set (Citadel gates app ACCESS; these are in-app roles).
export const ROLES = ['founder', 'admin', 'member'] as const;
type Role = (typeof ROLES)[number];

let _pool: Pool | undefined;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

function founderEmails(): string[] {
  return (process.env.FOUNDER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Allow if the session user's role is 'founder' OR their email is in the
 * FOUNDER_EMAILS allowlist (handles users created before the role field, and
 * self-heals their DB role). Returns the session, or an error response.
 */
async function requireFounder() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return { error: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  const user = session.user as { id: string; email?: string; role?: string };
  const byRole = user.role === 'founder';
  const byEmail = !!user.email && founderEmails().includes(user.email.toLowerCase());
  if (!byRole && !byEmail) {
    return { error: NextResponse.json({ error: 'founders only' }, { status: 403 }) };
  }
  if (byEmail && !byRole) {
    // self-heal: promote the allowlisted founder in the DB.
    await pool().query('UPDATE "user" SET role = $1 WHERE id = $2', ['founder', user.id]);
  }
  return { session };
}

export async function GET() {
  const gate = await requireFounder();
  if (gate.error) return gate.error;
  const { rows } = await pool().query(
    'SELECT id, email, name, COALESCE(role, $1) AS role, "createdAt" FROM "user" ORDER BY "createdAt" ASC',
    ['member'],
  );
  return NextResponse.json({ users: rows });
}

export async function PATCH(req: Request) {
  const gate = await requireFounder();
  if (gate.error) return gate.error;
  const body = (await req.json().catch(() => ({}))) as { userId?: string; role?: string };
  if (!body.userId || !ROLES.includes(body.role as Role)) {
    return NextResponse.json({ error: 'userId and a valid role are required' }, { status: 400 });
  }
  await pool().query('UPDATE "user" SET role = $1 WHERE id = $2', [body.role, body.userId]);
  return NextResponse.json({ ok: true });
}
