import { useEffect } from "react";
import { RibbonMark } from "../../ui/Ribbon/RibbonMark";

/** Development page: the mark alone on a transparent page, for rendering stills. */
export function RibbonStill() {
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  return (
    <div style={{ width: 1024, height: 1024 }}>
      <RibbonMark size={1024} />
    </div>
  );
}
