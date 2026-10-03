import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as path from 'path';

/**
 * Applies pending migrations and exits. Run as a release step BEFORE the new
 * application version starts (`node dist/src/db/migrate.js`); a non-zero exit
 * must fail the deployment. Uses MIGRATION_DATABASE_URL when set, so the
 * running app can use a role without schema-change rights.
 */
async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const migrationsFolder = process.env.MIGRATIONS_DIR || path.resolve(__dirname, 'migrations');
    await migrate(drizzle(pool), { migrationsFolder });
    // eslint-disable-next-line no-console
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('migration failed:', err);
  process.exit(1);
});
