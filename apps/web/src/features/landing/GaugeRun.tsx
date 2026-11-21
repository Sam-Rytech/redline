import { AnimatePresence, motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { useRef, useState } from "react";
import { heat, LIQUIDATION_RATIO } from "../../lib/gauge";
import { fmtUsd } from "../../lib/format";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { Gauge } from "../../ui/Gauge";
import s from "./GaugeRun.module.css";

const START_RATIO = 185;
const END_RATIO = 96;

type Step = { below: number; kicker: string; title: string; body: string };
const STEPS: Step[] = [
  { below: Infinity, kicker: "01 The loan", title: "Lock BCH. Borrow dollars.", body: "ParyonUSD lends you PUSD, a dollar stablecoin, against BCH you lock up. The gauge reads your collateral ratio: what the BCH is worth against what you owe." },
  { below: 165, kicker: "02 The price", title: "BCH falls. So does your ratio.", body: "Every dollar off the BCH price moves the needle toward the red zone. The protocol itself sends no warning." },
  { below: 135, kicker: "03 The alarm", title: "Redline lights up first.", body: "Before the needle reaches 110%, the lamp comes on and a Telegram message tells you how far you are from the line and at what BCH price you lose the collateral." },
  { below: LIQUIDATION_RATIO, kicker: "04 The line", title: "At 110%, the loan is gone.", body: "Paryon liquidates at 110% and the collateral is gone. With Redline you heard about it three times before that, early enough to add BCH or repay." },
];

/** Scroll drives a falling BCH price: the needle climbs, the lamp lights, the stripes cross at 110%. */
export function GaugeRun({ priceUsd }: { priceUsd: number }) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [p, setP] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => setP(v));

  const ratio = START_RATIO + (END_RATIO - START_RATIO) * p;
  const price = priceUsd * (ratio / START_RATIO);
  const crossed = ratio < LIQUIDATION_RATIO;
  const step = [...STEPS].reverse().find((x) => ratio < x.below) ?? STEPS[0]!;
  const objX = useTransform(scrollYProgress, [0, 0.5, 1], reduce ? ["0%", "0%", "0%"] : ["-6%", "4%", "-2%"]);
  const objRotate = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [-4, 3]);

  return (
    <section ref={ref} className={s.run} aria-label="How a ParyonUSD loan reaches the red line">
      <div className={s.stage}>
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

        <motion.div className={s.object} style={{ x: objX, rotate: objRotate }}>
          <Gauge ratio={ratio} spring={false} label={`Gauge at ${ratio.toFixed(0)}% collateral ratio`} />
        </motion.div>

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
              <span className="mono">Telegram · Redline</span>
              <strong>Loan 3f9a…c21e is {Math.max(0, Math.round((1 - LIQUIDATION_RATIO / ratio) * 100))}% from liquidation.</strong>
              <span>Liquidates if BCH reaches {fmtUsd(priceUsd * (LIQUIDATION_RATIO / START_RATIO))}. Add BCH or repay to move back.</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
