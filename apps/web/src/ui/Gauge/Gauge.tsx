import offSrc from "../../assets/tacho/front-off.webp";
import onSrc from "../../assets/tacho/front-on.webp";
import offSmall from "../../assets/tacho/front-off-512.webp";
import onSmall from "../../assets/tacho/front-on-512.webp";
import { lampLit, ratioToAngle } from "../../lib/gauge";
import { useReducedMotion } from "../../lib/useReducedMotion";
import s from "./Gauge.module.css";

type Props = {
  /** Collateral ratio in %, null when the loan has no debt. */
  ratio: number | null;
  /** Overrides the lamp; by default it lights near the red zone. */
  lit?: boolean;
  /** Animate the needle to its value (spring) instead of following input directly. */
  spring?: boolean;
  small?: boolean;
  label?: string;
  className?: string;
};

/** The tachometer: photographed dial, code needle, lamp that lights near the red zone. */
export function Gauge({ ratio, lit, spring = true, small = false, label, className = "" }: Props) {
  const reduce = useReducedMotion();
  const angle = ratioToAngle(ratio);
  const on = lit ?? lampLit(ratio);
  const sizes = small ? "(max-width: 600px) 40vw, 200px" : "(max-width: 600px) 90vw, 560px";

  return (
    <figure className={`${s.gauge} ${className}`} role="img" aria-label={label ?? describe(ratio)}>
      <img className={s.photo} src={offSrc} srcSet={`${offSmall} 512w, ${offSrc} 1024w`} sizes={sizes} alt="" draggable={false} />
      <img
        className={`${s.photo} ${s.lamp}`}
        style={{ opacity: on ? 1 : 0 }}
        src={onSrc}
        srcSet={`${onSmall} 512w, ${onSrc} 1024w`}
        sizes={sizes}
        alt=""
        draggable={false}
      />
      <svg className={s.needleLayer} viewBox="0 0 1024 1024" aria-hidden="true">
        <g
          className={s.needle}
          style={{ transform: `rotate(${angle}deg)`, transition: reduce || !spring ? "none" : undefined }}
        >
          <g filter="url(#needle-shadow)">
            <path d="M503 560 L506 330 L510 312 L514 330 L517 560 Z" fill="#F5F1E8" />
            <path d="M506 330 L510 312 L514 330 L513.4 352 L506.6 352 Z" fill="#E5321F" />
          </g>
        </g>
        <circle cx="510" cy="525" r="34" fill="#141312" />
        <circle cx="510" cy="525" r="34" fill="url(#cap-shine)" />
        <defs>
          <filter id="needle-shadow" x="-50%" y="-10%" width="200%" height="130%">
            <feDropShadow dx="4" dy="6" stdDeviation="4" floodColor="#000" floodOpacity="0.45" />
          </filter>
          <radialGradient id="cap-shine" cx="0.38" cy="0.32" r="0.7">
            <stop offset="0" stopColor="#4a4744" />
            <stop offset="0.6" stopColor="#1b1a18" />
            <stop offset="1" stopColor="#0e0d0c" />
          </radialGradient>
        </defs>
      </svg>
    </figure>
  );
}

function describe(ratio: number | null) {
  return ratio === null ? "Gauge: no debt on this loan" : `Gauge reading ${ratio.toFixed(1)}% collateral ratio`;
}
