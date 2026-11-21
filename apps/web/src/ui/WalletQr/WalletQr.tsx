import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import s from "./WalletQr.module.css";

/** The pairing code for a phone wallet, plus a link for a wallet on this device. */
export function WalletQr({ uri }: { uri: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ref.current) void QRCode.toCanvas(ref.current, uri, { width: 232, margin: 1, errorCorrectionLevel: "M" });
  }, [uri]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={s.wrap}>
      <canvas ref={ref} className={s.qr} role="img" aria-label="WizardConnect pairing code. Scan it with Paytaca or Selene." />
      <div className={s.links}>
        <a href={uri}>Open wallet on this device</a>
        <button type="button" onClick={copy}>{copied ? "Copied" : "Copy code"}</button>
      </div>
    </div>
  );
}
