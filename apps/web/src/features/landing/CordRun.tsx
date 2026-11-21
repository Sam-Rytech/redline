import type { LoansResponse } from "@redline/api-types";
import { PRO_PASS_DAYS, PRO_PASS_USD } from "@redline/api-types";
import { motion, useScroll, useSpring, useTransform } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import plugSrc from "../../assets/tacho/plug.webp";
import { fmtBch, fmtInt, fmtPusd } from "../../lib/format";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { ButtonLink } from "../../ui/Button";
import s from "./CordRun.module.css";

// The cord's route as fractions of the section (x of width, y of height), from the gauge to the plug.
function cordPath(w: number, h: number) {
  const P = (x: number, y: number) => `${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`;
  return `M${P(0, 0.02)} C${P(0.2, 0.02)} ${P(0.4, 0.06)} ${P(0.46, 0.14)} S${P(0.88, 0.3)} ${P(0.86, 0.42)} S${P(0.12, 0.56)} ${P(0.14, 0.68)} S${P(0.5, 0.82)} ${P(0.5, 0.94)} L${P(0.5, 1)}`;
}

/** Below the gauge: its cord runs down through the facts and ends in a plug beside Connect wallet. */
export function CordRun({ data }: { data: LoansResponse | null }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 70%", "end end"] });
  const drawn = useSpring(useTransform(scrollYProgress, [0, 0.82], [0, 1]), { stiffness: 120, damping: 30 });
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
          <motion.path d={cordPath(size.w, size.h)} className={s.cordShadow} style={reduce ? undefined : { pathLength: drawn }} />
          <motion.path d={cordPath(size.w, size.h)} className={s.cordBody} style={reduce ? undefined : { pathLength: drawn }} />
        </svg>
      )}

      <article className={`${s.block} ${s.left}`}>
        <p className={`${s.kicker} mono`}>05 What Redline reads</p>
        <h2 className={`${s.title} display`}>Every loan on the chain.</h2>
        <dl className={`${s.facts} num`}>
          <div><dt className="mono">Active loans</dt><dd>{sum ? fmtInt(sum.total) : "--"}</dd></div>
          <div><dt className="mono">Within 20% of the line</dt><dd>{sum ? fmtInt(sum.within20pct) : "--"}</dd></div>
          <div><dt className="mono">Borrowed</dt><dd>{sum ? fmtPusd(sum.totalDebtPusd) : "--"}</dd></div>
          <div><dt className="mono">Locked</dt><dd>{sum ? fmtBch(Math.round(sum.totalCollateralBch)) : "--"}</dd></div>
        </dl>
        <p className={s.body}>Read straight from Bitcoin Cash mainnet, block by block. No account needed to look.</p>
        <ButtonLink to="/loans" variant="quiet">Look up any loan</ButtonLink>
      </article>

      <article className={`${s.block} ${s.right}`}>
        <p className={`${s.kicker} mono`}>06 Left behind</p>
        <h2 className={`${s.title} display`}>
          {sum ? fmtBch(Math.round(sum.strandedBch * 10) / 10) : "BCH"} nobody has claimed.
        </h2>
        <p className={s.body}>
          {sum ? `${fmtInt(sum.strandedCount)} loans` : "Some loans"} were paid off by redemption but still hold their collateral.
          If one is yours, Redline shows you where it is.
        </p>
        <ButtonLink to="/loans?stranded=1" variant="quiet">Find stranded BCH</ButtonLink>
      </article>

      <article className={`${s.block} ${s.left}`}>
        <p className={`${s.kicker} mono`}>07 Free and Pro</p>
        <h2 className={`${s.title} display`}>One loan free. Every loan with Pro.</h2>
        <p className={s.body}>Free watches one loan with liquidation alerts. The Pro pass watches every loan you hold, with every alert rule.</p>
        <p className={s.terms}>
          Pro pass: {PRO_PASS_USD.toFixed(2)} USD, paid once in BCH. Lasts {PRO_PASS_DAYS} days. Does not renew. You are not charged again.
          Nothing to cancel.
        </p>
        <ButtonLink to="/pro">See the Pro pass</ButtonLink>
      </article>

      <div className={s.end}>
        <img ref={plugRef} className={s.plug} src={plugSrc} alt="" />
        <div className={s.connect}>
          <h2 className={`${s.title} display`}>Plug in your loan.</h2>
          <p className={s.body}>Sign in with your BCH wallet. Redline asks you to sign a message, never to send anything.</p>
          <ButtonLink to="/sign-in">Connect wallet</ButtonLink>
        </div>
      </div>
    </section>
  );
}
