import { connect, close as closeDb } from '../src/db.ts';
import { ensureIndexes } from '../src/schema.ts';
import { backfill } from '../src/backfill.ts';

async function main(): Promise<void> {
  await connect();
  await ensureIndexes();
  const result = await backfill();
  console.log(`[backfill] processed=${result.processed} lastSig=${result.lastSig}`);
  await closeDb();
}

main().catch((e) => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
