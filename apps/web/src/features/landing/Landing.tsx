import { useLoans } from "../../lib/useLoans";
import { Hero } from "./Hero";
import { GaugeRun } from "./GaugeRun";
import { CordRun } from "./CordRun";

/** Landing: the tachometer is the main character; the page follows it from the hero down the cord. */
export function Landing() {
  const { data } = useLoans();
  return (
    <main>
      <Hero data={data} />
      <GaugeRun priceUsd={data?.priceUsd ?? 190.5} />
      <CordRun data={data} />
    </main>
  );
}
