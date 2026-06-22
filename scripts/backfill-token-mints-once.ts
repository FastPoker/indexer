// One-shot: run the token-mint backfill sweep once and print the summary.
// Use this on prod to clean up the existing ghost-table data without
// waiting for the in-process periodic loop to fire.
//
//   cd /srv/fastpoker-indexer-mainnet && npx tsx scripts/backfill-token-mints-once.ts
import { connect, close as closeDb } from '../src/db.ts';
import { ensureIndexes } from '../src/schema.ts';
import { backfillMissingTokenMints } from '../src/backfill-token-mints.ts';

async function main(): Promise<void> {
  await connect();
  await ensureIndexes();

  const result = await backfillMissingTokenMints();
  console.log(JSON.stringify(result, null, 2));

  await closeDb();
}

main().catch((err) => {
  console.error('[backfill-token-mints-once] failed:', err);
  process.exit(1);
});
