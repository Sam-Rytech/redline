import type { Invoice, InvoiceQuote, Utxo } from "@redline/api-types";
import { PRO_PASS_DAYS, PRO_PASS_USD } from "@redline/api-types";
import { PaymentError, payProPass, type PayStep } from "@redline/wizard-login/client";
import { useCallback, useState } from "react";
import { api } from "../../lib/api";
import { demoWalletEnabled } from "../../lib/demoWallet";
import { useApi } from "../../lib/useApi";
import { useMe } from "../../lib/useMe";
import { pairWallet, useWallet } from "../../lib/wallet";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { WalletQr } from "../../ui/WalletQr";
import { SignInPrompt } from "./SignInPrompt";
import s from "./Account.module.css";

type Pay =
  | { stage: "idle" }
  | { stage: "waiting"; step: PayStep | null }
  | { stage: "paid"; invoice: Invoice }
  | { stage: "already"; message: string }
  | { stage: "failed"; message: string; safe: boolean };

const STEP: Record<PayStep, string> = {
  quote: "Getting today's BCH price",
  coins: "Choosing coins from your wallet",
  invoice: "Creating your invoice",
  signing: "Approve the payment in your wallet",
  submitting: "Sending the payment",
  checking: "Checking for the payment",
};

/** These failures happen before anything is signed, so no BCH moved. */
const SAFE = new Set(["no_paths", "no_funds", "wallet_rejected"]);

export function ProPass() {
  const { me, signedOut, reload } = useMe();
  const quote = useApi<InvoiceQuote>(me && !me.pro ? "/invoices/quote" : null);
  const wallet = useWallet();
  const [pay, setPay] = useState<Pay>({ stage: "idle" });
  const bch = quote.data ? (quote.data.amountSats / 1e8).toFixed(6) : null;
  const close = useCallback(() => setPay({ stage: "idle" }), []);

  // Never optimistic: the modal stays pending until the server has the payment.
  const start = async () => {
    setPay({ stage: "waiting", step: null });
    try {
      const conn = await pairWallet();
      const invoice = await payProPass({ manager: conn.manager, onStep: (step) => setPay({ stage: "waiting", step }) });
      setPay({ stage: "paid", invoice });
      reload();
    } catch (e) {
      if (e instanceof PaymentError && e.code === "already_paid") {
        reload();
        setPay({ stage: "already", message: e.message });
        return;
      }
      const code = e instanceof PaymentError ? e.code : "";
      setPay({ stage: "failed", message: (e as Error).message, safe: SAFE.has(code) });
    }
  };

  const demo = async () => {
    setPay({ stage: "waiting", step: "submitting" });
    try {
      const utxos = await api<Utxo[]>("/utxos?addresses=demo");
      const inv = await api<Invoice>("/invoices", { method: "POST", json: { asset: "BCH", inputs: utxos.slice(0, 1).map((u) => ({ txid: u.txid, vout: u.vout })) } });
      const paid = await api<Invoice>(`/invoices/${inv.id}/submit`, { method: "POST", json: { signedTxHex: "00" } });
      setPay({ stage: "paid", invoice: paid });
      reload();
    } catch (e) {
      setPay({ stage: "failed", message: (e as Error).message, safe: true });
    }
  };

  const pairing = pay.stage === "waiting" && pay.step === null && wallet.status === "pairing";
  const title =
    pay.stage === "paid" ? "Pro is on"
    : pay.stage === "already" ? "Already paid"
    : pay.stage === "failed" ? "Payment didn't go through"
    : pairing ? "Connect your wallet"
    : "Approve in your wallet";

  return (
    <main className={s.page}>
      <h1 className={`${s.h1} display`}>Pro pass</h1>
      <section className={s.block}>
        <ul className={s.features}>
          <li>Watch every loan you hold, not just one</li>
          <li>Loan-gone alerts as well as liquidation alerts</li>
          <li>Paid in BCH from your own wallet</li>
        </ul>
        {signedOut && <SignInPrompt what="buy the Pro pass" />}
        {me?.pro && <p className={s.body}>Pro is active until {me.proUntil ? new Date(me.proUntil).toLocaleDateString() : "the end of the pass"}.</p>}
        {me && !me.pro && (
          <div className={s.buy}>
            <Button onClick={start} state={pay.stage === "waiting" ? "working" : "idle"} aria-describedby="pro-terms">
              Pay {PRO_PASS_USD.toFixed(2)} USD in BCH
            </Button>
            <p id="pro-terms" className={s.terms}>
              {PRO_PASS_USD.toFixed(2)} USD, paid once in BCH{bch ? ` (about ${bch} BCH at today's price)` : ""}. Lasts {PRO_PASS_DAYS} days.
              Does not renew. You are not charged again. Nothing to cancel.
            </p>
            {demoWalletEnabled && (
              <Button variant="quiet" onClick={demo}>Pay with demo wallet (mock server)</Button>
            )}
          </div>
        )}
      </section>
      <Modal
        open={pay.stage !== "idle"}
        onClose={close}
        tone={pay.stage === "paid" || pay.stage === "already" ? "done" : pay.stage === "failed" ? "bad" : "wait"}
        title={title}
        actions={
          pay.stage === "waiting" ? (
            <Button variant="secondary" onClick={close}>Hide</Button>
          ) : (
            <Button onClick={close}>{pay.stage === "failed" ? "Close" : "Done"}</Button>
          )
        }
      >
        {pairing && wallet.status === "pairing" && (
          <>
            <p>Scan with Paytaca or Selene. Your wallet asks you to approve the payment next.</p>
            <WalletQr uri={wallet.qrUri} />
          </>
        )}
        {pay.stage === "waiting" && !pairing && (
          <p role="status">{pay.step ? STEP[pay.step] : "Connecting to your wallet"}. This page waits until the network has the payment.</p>
        )}
        {pay.stage === "paid" && (
          <>
            <p>Pro runs for {PRO_PASS_DAYS} days and does not renew.</p>
            <p className="mono">Receipt {pay.invoice.id}</p>
            {pay.invoice.txid && <p className="mono">Transaction {pay.invoice.txid.slice(0, 16)}…</p>}
          </>
        )}
        {pay.stage === "already" && <p>{pay.message}</p>}
        {pay.stage === "failed" && (
          <p role="alert">{pay.message}{pay.safe ? " No BCH left your wallet." : ""}</p>
        )}
      </Modal>
    </main>
  );
}
