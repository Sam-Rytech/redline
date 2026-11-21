import { useState } from "react";
import { useNavigate } from "react-router";
import { demoSignIn, demoWalletEnabled } from "../../lib/demoWallet";
import { Button, ButtonLink } from "../../ui/Button";
import { Gauge } from "../../ui/Gauge";
import { AgeScreen } from "./AgeScreen";
import { readAge, type AgeResult } from "./age";
import s from "./Auth.module.css";

export function SignIn() {
  const [age, setAge] = useState<AgeResult>(() => readAge());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const demo = async () => {
    setBusy(true);
    setErr(null);
    try {
      await demoSignIn();
      navigate("/me");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={s.page}>
      <div className={s.side} aria-hidden="true">
        <Gauge ratio={165} />
      </div>
      {age === null && <AgeScreen onResult={setAge} />}
      {age === "under" && (
        <section className={s.panel}>
          <h1 className={`${s.title} display`}>Redline is not available</h1>
          <p className={s.body}>We can't create an account for you. You can still look at every loan without signing in.</p>
          <ButtonLink to="/loans" variant="quiet">See every loan</ButtonLink>
        </section>
      )}
      {age === "ok" && (
        <section className={s.panel}>
          <p className={`${s.kicker} mono`}>Step 2 of 2</p>
          <h1 className={`${s.title} display`}>Sign in with your wallet</h1>
          <ol className={s.steps}>
            <li>Open a WizardConnect wallet on your phone and scan the code.</li>
            <li>Your wallet shows a message from Redline. Sign it. Nothing is sent and no BCH moves.</li>
            <li>Redline finds your loans from the wallet's addresses.</li>
          </ol>
          <div className={s.qr} role="img" aria-label="Wallet connection code appears here">
            <span className="mono">Wallet code</span>
          </div>
          {demoWalletEnabled && (
            <Button onClick={demo} disabled={busy}>{busy ? "Signing in" : "Use demo wallet (mock server)"}</Button>
          )}
          {err && <p className={s.err} role="alert">Sign-in failed: {err}</p>}
        </section>
      )}
    </main>
  );
}
