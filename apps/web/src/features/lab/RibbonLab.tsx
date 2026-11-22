import { RibbonMark } from "../../ui/Ribbon/RibbonMark";

/** Development page for judging the ribbon mark. */
export function RibbonLab() {
  return (
    <main style={{ display: "flex", gap: 24, alignItems: "center", justifyContent: "center", padding: 48, flexWrap: "wrap" }}>
      <RibbonMark size={520} />
      <RibbonMark size={520} spin />
    </main>
  );
}
