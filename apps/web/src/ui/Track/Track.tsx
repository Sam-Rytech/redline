import { LIQUIDATION_RATIO, ratioToTrack } from "../../lib/gauge";
import s from "./Track.module.css";

const TICKS = [300, 250, 200, 150, 125];

/** The dial laid flat: 300% on the left, the red line at 110%, a dot where this loan sits. */
export function Track({ ratio }: { ratio: number | null }) {
  const red = ratioToTrack(LIQUIDATION_RATIO) * 100;
  const at = ratio === null ? null : ratioToTrack(ratio) * 100;
  return (
    <div className={s.track} aria-hidden="true">
      <div className={s.rail}>
        {TICKS.map((t) => (
          <span key={t} className={s.tick} style={{ left: `${ratioToTrack(t) * 100}%` }} />
        ))}
        <span className={s.zone} style={{ left: `${red}%` }} />
        <span className={s.line} style={{ left: `${red}%` }} />
        {at !== null && <span className={s.dot} style={{ left: `${at}%` }} />}
      </div>
      <div className={`${s.labels} mono`}>
        <span>300%</span>
        <span className={s.redLabel} style={{ right: `${100 - red}%` }}>110%</span>
      </div>
    </div>
  );
}
