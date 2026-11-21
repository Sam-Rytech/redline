import type { LoanView } from "@redline/api-types";
import { Link } from "react-router";
import { fmtBch, fmtDistance, fmtPct, fmtPusd, shortId } from "../../lib/format";
import { Case } from "../../ui/Case";
import { RiskChip } from "../../ui/Chip";
import { Gauge } from "../../ui/Gauge";
import s from "./Loans.module.css";

export function LoanCard({ loan, to }: { loan: LoanView; to: string }) {
  return (
    <Case caseId={`loan-${loan.id}`} className={s.card}>
      <Link to={to} className={s.cardLink} aria-label={`Loan ${shortId(loan.id)}, ${fmtPct(loan.collateralRatioPct)}`}>
        <div className={s.cardGauge}>
          <Gauge ratio={loan.collateralRatioPct} small />
        </div>
        <div className={s.cardText}>
          <div className={s.cardHead}>
            <span className="mono">{shortId(loan.id)}</span>
            {loan.stranded ? <span className={`${s.stranded} mono`}>Stranded</span> : <RiskChip risk={loan.risk} />}
          </div>
          <p className={`${s.ratio} num`}>{fmtPct(loan.collateralRatioPct)}</p>
          <p className={s.meta}>
            {loan.stranded ? `${fmtBch(loan.collateralBch)} left in a paid-off loan` : `${fmtDistance(loan.distanceToLiquidation)} · ${fmtPusd(loan.debtPusd)}`}
          </p>
        </div>
      </Link>
    </Case>
  );
}
