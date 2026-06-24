import { redirect } from 'next/navigation';
import { currentUserId } from '@/lib/api-server';
import { getPoolInboxes } from '@/app/(dashboard)/_lib/data';
import { PoolPageClient } from './_components/PoolPageClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const poolInboxes = await getPoolInboxes();

  return <PoolPageClient initial={poolInboxes} />;
}
