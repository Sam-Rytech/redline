import type { LoansResponse } from "@redline/api-types";
import { PRO_PASS_DAYS, PRO_PASS_USD } from "@redline/api-types";
import { useLayoutEffect, useRef, useState } from "react";
import plugSrc from "../../assets/tacho/plug.webp";
import { fmtBch, fmtInt, fmtPusd } from "../../lib/format";
import { ButtonLink } from "../../ui/Button";
import s from "./CordRun.module.css";

// The cord's route as fractions of the section (x of width, y of height), from the gauge to the plug.
function cordPath(w: number, h: number, startX: number) {
  const P = (x: number, y: number) => `${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`;
  return `M${startX.toFixed(1)} -2 C${startX.toFixed(1)} ${(0.08 * h).toFixed(1)} ${P(0.4, 0.06)} ${P(0.46, 0.14)} S${P(0.88, 0.3)} ${P(0.86, 0.42)} S${P(0.12, 0.56)} ${P(0.14, 0.68)} S${P(0.5, 0.82)} ${P(0.5, 0.94)} L${P(0.5, 1)}`;
}

/** Below the gauge: its cord runs down through the facts and ends in a plug beside Connect wallet. */
export function CordRun({ data, startX }: { data: LoansResponse | null; startX: number }) {
  const ref = useRef<HTMLElement>(null);
  const sum = data?.summary;
  const plugRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // The cord ends exactly where the plug's cable begins.
  useLayoutEffect(() => {
    const measure = () => {
      if (!ref.current || !plugRef.current) return;
      const box = ref.current.getBoundingClientRect();
      setSize({ w: box.width, h: plugRef.current.getBoundingClientRect().top - box.top + 4 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [data]);

  return (
    <section ref={ref} className={s.run}>
      {size && (
        <svg className={s.cord} width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
          <path d={cordPath(size.w, size.h, startX)} className={s.cordShadow} />
          <path d={cordPath(size.w, size.h, startX)} className={s.cordBody} />
        </svg>
      )}

      <article className={`${s.block} ${s.left}`}>
        <p className={s.num}>05.</p>
        <p className={`${s.kicker} mono`}>On-chain monitoring</p>
        <h2 className={`${s.title} display`}>See the risk across every ParyonUSD loan.</h2>
        <dl className={`${s.facts} num`}>
          <div><dt className="mono">Active loans</dt><dd>{sum ? fmtInt(sum.total) : "--"}</dd></div>
          <div><dt className="mono">Within 20% of liquidation</dt><dd>{sum ? fmtInt(sum.within20pct) : "--"}</dd></div>
          <div><dt className="mono">Borrowed</dt><dd>{sum ? fmtPusd(sum.totalDebtPusd) : "--"}</dd></div>
          <div><dt className="mono">Locked collateral</dt><dd>{sum ? fmtBch(Math.round(sum.totalCollateralBch)) : "--"}</dd></div>
        </dl>
        <p className={s.body}>Redline reads loan data directly from Bitcoin Cash, so you can check the whole market without connecting a wallet. Figures update with every block.</p>
        <ButtonLink to="/loans" variant="quiet">Explore loans</ButtonLink>
      </article>

      <article className={`${s.block} ${s.right}`}>
        <p className={s.num}>06.</p>
        <p className={`${s.kicker} mono`}>Unclaimed collateral</p>
        <h2 className={`${s.title} display`}>You may still have BCH to claim.</h2>
        <p className={s.body}>
          Some loans were repaid through redemption, but their remaining collateral hasn't been claimed
          {sum ? ` (${fmtInt(sum.strandedCount)} loans holding ${fmtBch(Math.round(sum.strandedBch * 10) / 10)} right now)` : ""}. Redline helps
          you check whether any of it belongs to you.
        </p>
        <ButtonLink to="/loans?stranded=1" variant="quiet">Find unclaimed BCH</ButtonLink>
      </article>

      <article className={`${s.block} ${s.left}`}>
        <p className={s.num}>07.</p>
        <p className={`${s.kicker} mono`}>Plans</p>
        <h2 className={`${s.title} display`}>Monitor one loan for free, or all your loans with Pro.</h2>
        <div className={s.plans}>
          <div className={s.plan}>
            <p className="mono">Free</p>
            <p className={s.price}>$0</p>
            <p className={s.body}>Monitor one loan with liquidation alerts.</p>
          </div>
          <div className={s.plan}>
            <p className="mono">Pro</p>
            <p className={s.price}>${PRO_PASS_USD.toFixed(2)}</p>
            <p className={s.body}>Monitor all your loans with every alert rule.</p>
          </div>
        </div>
        <p className={s.terms}>
          Pro pass: {PRO_PASS_USD.toFixed(2)} USD, paid once in BCH. Lasts {PRO_PASS_DAYS} days. One-time payment, no auto-renewal: you are
          not charged again and there is nothing to cancel.
        </p>
        <ButtonLink to="/pro">See the Pro pass</ButtonLink>
      </article>

      <div className={s.end}>
        <img ref={plugRef} className={s.plug} src={plugSrc} alt="" />
        <div className={s.connect}>
          <h2 className={`${s.title} display`}>Start monitoring your BCH loans.</h2>
          <p className={s.body}>Connect your wallet to find your loans and set up Telegram alerts.</p>
          <ButtonLink to="/sign-in">Connect wallet</ButtonLink>
        </div>
      </div>
    </section>
  );
}
