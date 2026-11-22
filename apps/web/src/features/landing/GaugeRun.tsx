import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { heat, LIQUIDATION_RATIO } from "../../lib/gauge";
import { fmtUsd } from "../../lib/format";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { Gauge } from "../../ui/Gauge";
import { SHEEN } from "./cord";
import s from "./GaugeRun.module.css";

const START_RATIO = 185;
const END_RATIO = 96;

// The braided cable in the gauge photo (1024 px square): centre line from the red sleeve to the image's
// left edge, and its width, measured from the image's pixels.
const PHOTO_PX = 1024;
const BRAID: readonly (readonly [number, number])[] = [[116, 592.5], [96, 599.5], [72, 610.5], [48, 623], [24, 639], [0, 656.5]];
const BRAID_WIDTH = 28.5;

type Step = { below: number; kicker: string; title: string; body: string };
const STEPS: Step[] = [
  { below: Infinity, kicker: "01 · The loan", title: "Borrow PUSD using your BCH.", body: "ParyonUSD lets you lock BCH as collateral and borrow PUSD against it. Your collateral ratio tells you how much your BCH is worth compared with what you owe." },
  { below: 165, kicker: "02 · The price", title: "When BCH falls, your loan becomes riskier.", body: "As the price of BCH drops, your collateral ratio falls too. If it reaches the liquidation threshold, your collateral is at risk. ParyonUSD doesn't send liquidation warnings." },
  { below: 135, kicker: "03 · The alert", title: "Get notified before liquidation.", body: "Redline watches your loan and sends Telegram alerts as it approaches the liquidation threshold, including the BCH price that would put your collateral at risk." },
  { below: LIQUIDATION_RATIO, kicker: "04 · Liquidation", title: "At 110%, your collateral can be liquidated.", body: "Once the collateral ratio reaches the protocol's liquidation threshold, the protocol can liquidate your collateral. Redline warns you beforehand so you can act while there is still time." },
];

/** Scroll drives a falling BCH price: the needle climbs, the lamp lights, the stripes cross at 110%. */
export function GaugeRun({ priceUsd, onCord }: { priceUsd: number; onCord: (x: number, width: number) => void }) {
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
  const [cord, setCord] = useState<{ d: string; shadow: string; w: number; fade: [number, number] } | null>(null);

  // The cord is drawn over the photo's braided cable from the red sleeve down, so the whole cable is one
  // material with no seam, then drops to the bottom of the stage, where the next section picks it up.
  useLayoutEffect(() => {
    const measure = () => {
      const stage = stageRef.current?.getBoundingClientRect();
      const obj = objRef.current?.getBoundingClientRect();
      if (!stage || !obj) return;
      const kx = obj.width / PHOTO_PX, ky = obj.height / PHOTO_PX;
      const pts = BRAID.map(([x, y]) => [obj.left - stage.left + x * kx, obj.top - stage.top + y * ky] as const);
      const w = BRAID_WIDTH * kx;
      const f = (n: number) => n.toFixed(1);
      let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] ?? pts[i]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[i + 2] ?? p2;
        d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
      }
      const [sx, sy] = pts[pts.length - 1]!;
      const [px, py] = pts[pts.length - 2]!;
      const len = Math.hypot(sx - px, sy - py);
      const ux = (sx - px) / len, uy = (sy - py) / len;
      const ex = Math.max(w / 2 + 6, sx - obj.width * 0.1);
      const run = Math.max(sx - ex, w * 1.5);
      d += ` C${f(sx + ux * run * 0.9)} ${f(sy + uy * run * 0.9)} ${f(ex)} ${f(sy + run * 0.8)} ${f(ex)} ${f(sy + run * 1.8)}`;
      // The shadow (drawn 8px lower) overlaps the next section's shadow by 1px, 4px above the edge.
      setCord({ d: `${d} L${f(ex)} ${f(stage.height + 2)}`, shadow: `${d} L${f(ex)} ${f(stage.height - 11)}`, w, fade: [pts[0]![1], sy + run * 1.8] });
      onCord(ex, w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stageRef.current) ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [onCord]);

  return (
    <section ref={ref} className={s.run} aria-label="How a ParyonUSD loan reaches the red line">
      <div className={s.stage} ref={stageRef}>
        {cord && (
          <svg className={s.innerCord} aria-hidden="true">
            <path d={cord.shadow} className={s.cordShadow} style={{ strokeWidth: cord.w + 5 }} />
            <path d={cord.d} style={{ strokeWidth: cord.w }} />
            <defs>
              <linearGradient id="gauge-cord-shade" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={cord.fade[0]} y2={cord.fade[1]}>
                <stop offset="0" stopColor="#000" stopOpacity="0" />
                <stop offset="1" stopColor="#000" stopOpacity="0.08" />
              </linearGradient>
              <filter id="gauge-cord-sheen" x="-5%" y="-5%" width="110%" height="110%">
                <feGaussianBlur stdDeviation={cord.w * SHEEN.blur} />
              </filter>
            </defs>
            <path d={cord.d} className={s.sheen} filter="url(#gauge-cord-sheen)" style={{ strokeWidth: cord.w * SHEEN.width, translate: `${cord.w * SHEEN.x}px ${cord.w * SHEEN.y}px` }} />
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
