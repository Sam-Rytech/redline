import { LoginError, wizardLogin, type LoginStep } from "@redline/wizard-login/client";
import { useState } from "react";
import { useNavigate } from "react-router";
import { demoSignIn, demoWalletEnabled } from "../../lib/demoWallet";
import { pairWallet, useWallet } from "../../lib/wallet";
import { Button, ButtonLink } from "../../ui/Button";
import { WalletQr } from "../../ui/WalletQr";
import { AgeScreen } from "./AgeScreen";
import { readAge, type AgeResult } from "./age";
import { Reveal } from "../../ui/Reveal";
import s from "./Auth.module.css";

const STEP: Record<LoginStep, string> = {
  addresses: "Reading your wallet's addresses",
  utxos: "Finding a coin to sign with",
  challenge: "Asking Redline for a one-time code",
  signing: "Approve the sign-in message in your wallet. Nothing is sent.",
  verifying: "Checking the signature",
};

export function SignIn() {
  const [age, setAge] = useState<AgeResult>(() => readAge());
  const [step, setStep] = useState<LoginStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; address?: string } | null>(null);
  const wallet = useWallet();
  const navigate = useNavigate();

  const signIn = async () => {
    setBusy(true);
    setErr(null);
    setStep(null);
    try {
      const conn = await pairWallet();
      await wizardLogin({ manager: conn.manager, onStep: (st) => setStep(st) });
      navigate("/me");
    } catch (e) {
      const address = e instanceof LoginError ? e.address : undefined;
      setErr({ message: (e as Error).message, address });
    } finally {
      setBusy(false);
    }
  };

  const demo = async () => {
    setBusy(true);
    setErr(null);
    try {
      await demoSignIn();
      navigate("/me");
    } catch (e) {
      setErr({ message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={s.page}>
      {age === null && <Reveal from="pop"><AgeScreen onResult={setAge} /></Reveal>}
      {age === "under" && (
        <Reveal from="pop">
        <section className={s.panel}>
          <h1 className={`${s.title} display`}>Redline is not available</h1>
          <p className={s.body}>We can't create an account for you. You can still look at every loan without signing in.</p>
          <ButtonLink to="/loans" variant="quiet">See every loan</ButtonLink>
        </section>
        </Reveal>
      )}
      {age === "ok" && (
        <Reveal from="pop">
        <section className={s.panel}>
          <p className={`${s.kicker} mono`}>Step 2 of 2</p>
          <h1 className={`${s.title} display`}>Sign in with your wallet</h1>
          <ol className={s.steps}>
            <li>Open Paytaca or Selene on your phone and scan the code.</li>
            <li>Your wallet shows a message from Redline. Sign it. Nothing is sent and no BCH moves.</li>
            <li>Redline finds your loans from the wallet's addresses.</li>
          </ol>
          {wallet.status === "pairing" && <WalletQr uri={wallet.qrUri} />}
          {wallet.status === "ready" && busy && (
            <p className={s.status} role="status">
              {wallet.name ? `Connected to ${wallet.name}. ` : ""}
              {step ? STEP[step] : "Connected."}
            </p>
          )}
          {!busy && (
            <Button onClick={signIn}>{wallet.status === "ready" ? "Sign in" : "Connect wallet"}</Button>
          )}
          {busy && wallet.status === "pairing" && <p className={s.status} role="status">Waiting for your wallet</p>}
          {err && (
            <p className={s.err} role="alert">
              {err.message}
              {err.address && <span className={`${s.address} mono`}>{err.address}</span>}
            </p>
          )}
          {demoWalletEnabled && !busy && (
            <Button variant="quiet" onClick={demo}>Use demo wallet (mock server)</Button>
          )}
        </section>
        </Reveal>
      )}
    </main>
  );
}
