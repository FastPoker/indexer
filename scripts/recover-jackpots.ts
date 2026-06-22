import { connect, close as closeDb } from '../src/db.ts';
import { ensureIndexes } from '../src/schema.ts';
import { config } from '../src/config.ts';
import { recoverJackpotsAndReports } from '../src/recover.ts';

/**
 * Manual one-off recovery for missed jackpot receipts + hand-report chunks.
 * Window: hours back from now. Defaults to RECOVER_LOOKBACK_HOURS (or the
 * backfill lookback if that's unset). Override with the first CLI arg, e.g.
 * `npx tsx scripts/recover-jackpots.ts 336`.
 *
 * Identical work to the env-gated startup pass in index.ts — both call
 * recoverJackpotsAndReports(). Safe to run repeatedly (idempotent upserts).
 */
async function main(): Promise<void> {
  const hours = Number(process.argv[2]) || config.recover.lookbackHours || config.backfill.lookbackHours;
  await connect();
  await ensureIndexes();
  await recoverJackpotsAndReports(hours);
  await closeDb();
}

main().catch((e) => {
  console.error('[recover] fatal:', e);
  process.exit(1);
});
