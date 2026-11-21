import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import s from "./Button.module.css";

type Variant = "primary" | "secondary" | "quiet";
type Common = { variant?: Variant; children: ReactNode; className?: string };

export function Button({ variant = "primary", className = "", ...rest }: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${s.btn} ${s[variant]} ${className}`} {...rest} />;
}

export function ButtonLink({ to, variant = "primary", className = "", children }: Common & { to: string }) {
  return (
    <Link to={to} className={`${s.btn} ${s[variant]} ${className}`}>
      {children}
    </Link>
  );
}
