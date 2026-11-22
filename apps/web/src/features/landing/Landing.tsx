import { useCallback, useState } from "react";
import { useLoans } from "../../lib/useLoans";
import { Hero } from "./Hero";
import { GaugeRun } from "./GaugeRun";
import { CordRun } from "./CordRun";

/** Landing: the tachometer is the main character; the page follows it from the hero down the cord. */
export function Landing() {
  const { data } = useLoans();
  const [cordX, setCordX] = useState(48);
  const onCordX = useCallback((x: number) => setCordX(x), []);
  return (
    <main>
      <Hero data={data} />
      <GaugeRun priceUsd={data?.priceUsd ?? 190.5} onCordX={onCordX} />
      <CordRun data={data} startX={cordX} />
    </main>
  );
}
