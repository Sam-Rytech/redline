import type { LoansResponse } from "@redline/api-types";
import { motion, useScroll, useTransform } from "motion/react";
import heroSrc from "../../assets/tacho/hero.webp";
import heroSmall from "../../assets/tacho/hero-512.webp";
import { fmtInt, fmtPct, fmtUsd } from "../../lib/format";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { ButtonLink } from "../../ui/Button";
import s from "./Hero.module.css";

export function Hero({ data }: { data: LoansResponse | null }) {
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();
  const ghostX = useTransform(scrollY, [0, 800], [0, reduce ? 0 : -160]);
  const objY = useTransform(scrollY, [0, 800], [0, reduce ? 0 : 120]);
  const lowest = data?.loans.reduce<number | null>((min, l) => {
    const r = l.collateralRatioPct;
    return r !== null && (min === null || r < min) ? r : min;
  }, null);

  return (
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={s.grid} aria-hidden="true" />
      <motion.div className={`${s.ghost} display`} style={{ x: ghostX }} aria-hidden="true">
        Redline
      </motion.div>
      <motion.img
        className={s.object}
        style={{ y: objY }}
        src={heroSrc}
        srcSet={`${heroSmall} 512w, ${heroSrc} 1536w`}
        sizes="(max-width: 700px) 110vw, 70vw"
        alt="A Redline loan gauge: a tachometer reading collateral ratio, with a red zone at 110 percent and a warning lamp on top"
        fetchPriority="high"
      />
      <h1 id="hero-title" className={`${s.title} display`}>
        <span className={s.top}>Don't let<br />liquidation</span>
        <span className={s.bottom}>catch you<br />off guard.</span>
      </h1>
      <dl className={`${s.readout} mono num`}>
        <div><dt>Loans watched</dt><dd>{data ? fmtInt(data.summary.total) : "--"}</dd></div>
        <div><dt>Lowest ratio</dt><dd>{lowest !== undefined && lowest !== null ? fmtPct(lowest) : "--"}</dd></div>
        <div><dt>BCH</dt><dd>{data ? fmtUsd(data.priceUsd) : "--"}</dd></div>
      </dl>
      <p className={s.lead}>
        Get Telegram alerts before your ParyonUSD loan reaches liquidation, so you have time to add collateral or repay.
      </p>
      <div className={s.actions}>
        <ButtonLink to="/sign-in" beckon>Watch my loan</ButtonLink>
        <ButtonLink to="/loans" variant="quiet">Explore loans</ButtonLink>
      </div>
      <p className={`${s.sub} mono`}>Liquidation monitoring for ParyonUSD</p>
    </section>
  );
}
