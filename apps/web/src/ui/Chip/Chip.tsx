import type { RiskBand } from "@redline/api-types";
import s from "./Chip.module.css";

const LABEL: Record<RiskBand, string> = { safe: "Safe", watch: "Watch", danger: "Danger", critical: "Critical" };

/** Risk is always shown as a word, never colour alone. */
export function RiskChip({ risk }: { risk: RiskBand }) {
  return <span className={`${s.chip} ${s[risk]} mono`}>{LABEL[risk]}</span>;
}
