import type { LoanView } from "@redline/api-types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { fmtBch, fmtDistance, fmtPct, fmtPusd, fmtUsd, shortId } from "../../lib/format";
import { Case } from "../../ui/Case";
import { RiskChip } from "../../ui/Chip";
import { Gauge } from "../../ui/Gauge";
import { WatchToggle } from "./WatchToggle";
import s from "./Loans.module.css";

/** The loan's card grown to a full panel. Escape or the backdrop puts it back. */
export function LoanDetail({ loan, onClose }: { loan: LoanView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={s.detailRoot}>
      <motion.div className={s.backdrop} onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <Case caseId={`loan-${loan.id}`} className={s.detail} role="dialog" aria-modal="true" aria-label={`Loan ${shortId(loan.id)}`}>
        <button className={s.back} onClick={onClose} aria-label="Close loan">
          <svg viewBox="0 0 256 256" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M224 128a12 12 0 0 1-12 12H69l51.52 51.51a12 12 0 0 1-17 17l-72-72a12 12 0 0 1 0-17l72-72a12 12 0 0 1 17 17L69 116h143a12 12 0 0 1 12 12Z" />
          </svg>
        </button>
        <div className={s.detailGauge}>
          <Gauge ratio={loan.collateralRatioPct} />
        </div>
        <AnimatePresence>
          <motion.div className={s.detailBody} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <div className={s.cardHead}>
              <span className="mono">Loan {shortId(loan.id)}</span>
              {loan.stranded ? <span className={`${s.stranded} mono`}>Stranded</span> : <RiskChip risk={loan.risk} />}
            </div>
            <p className={`${s.bigRatio} display num`}>{fmtPct(loan.collateralRatioPct)}</p>
            <dl className={`${s.rows} num`}>
              <Row k="Distance" v={fmtDistance(loan.distanceToLiquidation)} />
              <Row k="Liquidates at BCH" v={loan.liquidationPriceUsd === null ? "No debt" : fmtUsd(loan.liquidationPriceUsd)} />
              <Row k="Debt" v={fmtPusd(loan.debtPusd)} />
              <Row k="Collateral" v={fmtBch(loan.collateralBch)} />
              <Row k="Interest" v={`${loan.interestRatePct}%${loan.pendingRateChange ? ` (changing to ${loan.nextInterestRatePct}%)` : ""}`} />
              <Row k="Redeemed before yours" v={fmtPusd(loan.debtAheadPusd)} />
            </dl>
            {loan.stranded && (
              <p className={s.note}>This loan is paid off but still holds {fmtBch(loan.collateralBch)}. Its owner can claim it in Paryon.</p>
            )}
            <div className={s.detailActions}>
              <WatchToggle loanId={loan.id} />
              <a className={s.ext} href={loan.paryonUrl} target="_blank" rel="noreferrer">Open in Paryon</a>
            </div>
          </motion.div>
        </AnimatePresence>
      </Case>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className={s.row}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
