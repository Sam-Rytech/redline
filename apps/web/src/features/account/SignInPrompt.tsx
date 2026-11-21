import { ButtonLink } from "../../ui/Button";
import s from "./Account.module.css";

export function SignInPrompt({ what }: { what: string }) {
  return (
    <div className={s.prompt}>
      <p>Sign in with your wallet to {what}.</p>
      <ButtonLink to="/sign-in">Sign in with wallet</ButtonLink>
    </div>
  );
}
