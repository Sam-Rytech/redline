import { ButtonLink } from "../ui/Button";
import s from "./Shell/Shell.module.css";

export function NotFound() {
  return (
    <main className={s.page}>
      <h1 className="display" style={{ fontSize: 72 }}>Off the dial</h1>
      <p className={s.lead}>This page does not exist. The loans you came for are one tap away.</p>
      <ButtonLink to="/loans">See all loans</ButtonLink>
    </main>
  );
}
