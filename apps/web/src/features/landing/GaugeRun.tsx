import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { heat, LIQUIDATION_RATIO } from "../../lib/gauge";
import { fmtUsd } from "../../lib/format";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { Gauge } from "../../ui/Gauge";
import s from "./GaugeRun.module.css";

const START_RATIO = 185;
const END_RATIO = 96;

type Step = { below: number; kicker: string; title: string; body: string };
const STEPS: Step[] = [
  { below: Infinity, kicker: "01 · The loan", title: "Borrow PUSD using your BCH.", body: "ParyonUSD lets you lock BCH as collateral and borrow PUSD against it. Your collateral ratio tells you how much your BCH is worth compared with what you owe." },
  { below: 165, kicker: "02 · The price", title: "When BCH falls, your loan becomes riskier.", body: "As the price of BCH drops, your collateral ratio falls too. If it reaches the liquidation threshold, your collateral is at risk. ParyonUSD doesn't send liquidation warnings." },
  { below: 135, kicker: "03 · The alert", title: "Get notified before liquidation.", body: "Redline watches your loan and sends Telegram alerts as it approaches the liquidation threshold, including the BCH price that would put your collateral at risk." },
  { below: LIQUIDATION_RATIO, kicker: "04 · Liquidation", title: "At 110%, your collateral can be liquidated.", body: "Once the collateral ratio reaches the protocol's liquidation threshold, the protocol can liquidate your collateral. Redline warns you beforehand so you can act while there is still time." },
];

/** Scroll drives a falling BCH price: the needle climbs, the lamp lights, the stripes cross at 110%. */
export function GaugeRun({ priceUsd, onCordX }: { priceUsd: number; onCordX: (x: number) => void }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [p, setP] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => setP(v));

  const ratio = START_RATIO + (END_RATIO - START_RATIO) * p;
  const price = priceUsd * (ratio / START_RATIO);
  const crossed = ratio < LIQUIDATION_RATIO;
  const step = [...STEPS].reverse().find((x) => ratio < x.below) ?? STEPS[0]!;
  const stageRef = useRef<HTMLDivElement>(null);
  const objRef = useRef<HTMLDivElement>(null);
  const [cord, setCord] = useState<string | null>(null);

  // The cable leaves the photo at its left edge, 63% down. The cord runs from there to the
  // bottom of the stage, where the next section picks it up at the same x.
  useLayoutEffect(() => {
    const measure = () => {
      const stage = stageRef.current?.getBoundingClientRect();
      const obj = objRef.current?.getBoundingClientRect();
      if (!stage || !obj) return;
      const sx = obj.left - stage.left + 2;
      const sy = obj.top - stage.top + obj.height * 0.63;
      const ex = Math.max(28, sx - 70);
      const ey = stage.height + 2;
      setCord(`M${sx} ${sy} C${sx - 60} ${sy + 10} ${ex} ${sy + 60} ${ex} ${Math.min(ey, sy + 160)} L${ex} ${ey}`);
      onCordX(ex);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stageRef.current) ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [onCordX]);

  return (
    <section ref={ref} className={s.run} aria-label="How a ParyonUSD loan reaches the red line">
      <div className={s.stage} ref={stageRef}>
        {cord && (
          <svg className={s.innerCord} aria-hidden="true">
            <path d={cord} />
          </svg>
        )}
        <div className={s.grid} aria-hidden="true" />
        <div className={s.glow} style={{ opacity: heat(ratio) }} aria-hidden="true" />
        <AnimatePresence>
          {crossed && !reduce && (
            <motion.div
              className={s.stripes}
              initial={{ x: "-110%" }}
              animate={{ x: "110%" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
              aria-hidden="true"
            />
          )}
        </AnimatePresence>

        <div className={s.object} ref={objRef}>
          <Gauge ratio={ratio} spring={false} label={`Gauge at ${ratio.toFixed(0)}% collateral ratio`} />
        </div>

        <dl className={`${s.readout} mono num`} aria-live="off">
          <div><dt>BCH</dt><dd>{fmtUsd(price)}</dd></div>
          <div><dt>Ratio</dt><dd className={crossed ? s.hot : ""}>{ratio.toFixed(1)}%</dd></div>
          <div><dt>Line</dt><dd>{LIQUIDATION_RATIO}%</dd></div>
        </dl>

        <div className={s.copy}>
          <AnimatePresence mode="wait">
            <motion.div
              key={step.kicker}
              initial={{ opacity: 0, y: reduce ? 0 : 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : -16 }}
              transition={{ duration: 0.22 }}
            >
              <p className={`${s.kicker} mono`}>{step.kicker}</p>
              <h2 className={`${s.title} display`}>{step.title}</h2>
              <p className={s.body}>{step.body}</p>
            </motion.div>
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {ratio < 135 && ratio >= LIQUIDATION_RATIO && (
            <motion.div
              className={s.alert}
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ type: "spring", stiffness: 300, damping: 26 }}
              role="status"
            >
              <span className="mono">Example alert · Telegram</span>
              <strong>Loan 3f9a…c21e: BCH can fall {Math.max(0, Math.round((1 - LIQUIDATION_RATIO / ratio) * 100))}% before liquidation.</strong>
              <span>Liquidation price: {fmtUsd(priceUsd * (LIQUIDATION_RATIO / START_RATIO))} per BCH. Add BCH or repay part of the loan to raise your collateral ratio.</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
