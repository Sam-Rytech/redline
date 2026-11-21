import type { RawLoan } from "@redline/paryon-decoder";
import type { Db } from "./open.js";

const cents = (pusd: number) => Math.round(pusd * 100);

/**
 * Stores one row per loan for this block height. A block already recorded is skipped, so calling
 * this on every refresh writes about once per block. Returns the number of rows written.
 */
export function recordSnapshot(db: Db, snap: { blockHeight: number; loans: RawLoan[] }): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO loan_snapshots
       (block_height, loan_id, debt_cents, collateral_sats, rate_raw, next_rate_raw, redeeming_cents, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let written = 0;
  db.exec("BEGIN");
  try {
    for (const l of snap.loans) {
      written += Number(
        insert.run(
          snap.blockHeight, l.id, cents(l.debtPusd), l.collateralSats, l.rateRaw, l.nextRateRaw,
          cents(l.amountBeingRedeemedPusd), l.status,
        ).changes,
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return written;
}
