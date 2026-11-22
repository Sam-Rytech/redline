import { useCallback, useState } from "react";
import { useLoans } from "../../lib/useLoans";
import { Hero } from "./Hero";
import { GaugeRun } from "./GaugeRun";
import { CordRun } from "./CordRun";

/** Landing: the tachometer is the main character; the page follows it from the hero down the cord. */
export function Landing() {
  const { data } = useLoans();
  const [cord, setCord] = useState({ x: 48, width: 13 });
  const onCord = useCallback((x: number, width: number) => setCord({ x, width }), []);
  return (
    <main>
      <Hero data={data} />
      <GaugeRun priceUsd={data?.priceUsd ?? 190.5} onCord={onCord} />
      <CordRun data={data} startX={cord.x} width={cord.width} />
    </main>
  );
}
