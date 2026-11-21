import { RIBBON_CLIP, RIBBON_D, RIBBON_VIEWBOX, RIBBON_WIDTH } from "./ribbon";
import { SCRIPT_PATH } from "./script";
import s from "./Logo.module.css";

/** The mark: the ribbon as one clean red stroke. */
export function Mark({ size = 28, className = "" }: { size?: number; className?: string }) {
  const { x, y, w, h } = RIBBON_VIEWBOX;
  return (
    <svg className={`${s.mark} ${className}`} height={size} width={(size * w) / h} viewBox={`${x} ${y} ${w} ${h}`} aria-hidden="true">
      <defs>
        <clipPath id="ribbon-cut">
          <path d={RIBBON_CLIP} />
        </clipPath>
      </defs>
      <path
        d={RIBBON_D}
        clipPath="url(#ribbon-cut)"
        fill="none"
        stroke="var(--brand-red)"
        strokeWidth={RIBBON_WIDTH}
        strokeLinejoin="round"
        strokeLinecap="butt"
      />
    </svg>
  );
}

export function Script({ height = 28, className = "" }: { height?: number; className?: string }) {
  return (
    <svg className={className} height={height} width={(height * 1040) / 300} viewBox="0 0 1040 300" aria-hidden="true">
      <g transform="translate(0 300) scale(0.1 -0.1)" fill="currentColor">
        <path d={SCRIPT_PATH} />
      </g>
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className={s.logo} role="img" aria-label="Redline">
      <Mark size={size * 1.2} />
      <Script height={size * 1.15} />
    </span>
  );
}
