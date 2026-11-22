import { ButtonLink } from "../../ui/Button";
import { Reveal } from "../../ui/Reveal";
import s from "./Account.module.css";

export function SignInPrompt({ what }: { what: string }) {
  return (
    <Reveal from="pop" delay={0.1}>
      <div className={s.prompt}>
        <p>Sign in with your wallet to {what}.</p>
        <ButtonLink to="/sign-in">Sign in with wallet</ButtonLink>
      </div>
    </Reveal>
  );
}
