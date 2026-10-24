import { useEffect, useState } from "react";
import { api } from "./api.js";
import { cap } from "./format.js";
import { Icon } from "./SideMenu.jsx";

// Web Bluetooth only exists in Chromium browsers (Chrome, Edge, Android) on https or localhost.
const supported = typeof navigator !== "undefined" && "bluetooth" in navigator && window.isSecureContext;

export default function BluetoothPay({ accounts, defaultId, onDone }) {
  const [device, setDevice] = useState(null);   // { name, demo }
  const [scanning, setScanning] = useState(false);
  const [accountId, setAccountId] = useState(defaultId);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAccountId((cur) => (accounts.some((a) => a.id === cur) ? cur : defaultId));
  }, [accounts, defaultId]);

  const scan = async () => {
    setError("");
    setScanning(true);
    try {
      const found = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      setDevice({ name: found.name || "Unnamed device", demo: false });
    } catch (ex) {
      // NotFoundError = the person closed the chooser without picking anything.
      if (ex.name !== "NotFoundError") setError("Couldn't scan for devices: " + ex.message);
    } finally {
      setScanning(false);
    }
  };

  const pay = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/bluetooth-pay", {
        method: "POST",
        body: { account_id: Number(accountId), to_account_number: to, amount, device_name: device.name },
      });
      setAmount(""); setTo(""); setDevice(null);
      await onDone();
    } catch (ex) {
      setError(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className={"bt-device"}>
        <span className={"bt-icon" + (scanning ? " pulse" : "")}><Icon name="bluetooth" /></span>
        <div>
          <strong>{device ? device.name : scanning ? "Searching for devices…" : "No device selected"}</strong>
          <small>{device ? (device.demo ? "Demo device (not real Bluetooth)" : "Nearby device selected") : "Pick the terminal or phone you're paying"}</small>
        </div>
        {device
          ? <button className="btn ghost" type="button" onClick={() => setDevice(null)}>Change</button>
          : supported
            ? <button className="btn primary" type="button" onClick={scan} disabled={scanning}>Scan</button>
            : <button className="btn" type="button" onClick={() => setDevice({ name: "Demo Terminal", demo: true })}>Use demo</button>}
      </div>

      {!supported && (
        <p className="note" style={{ marginTop: 0, marginBottom: 16 }}>
          This browser can't use Bluetooth (needs Chrome or Edge, over https or localhost). You can try the flow with a demo device.
        </p>
      )}

      <form onSubmit={pay}>
        <label>Pay from
          <select value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{cap(a.type)} · {a.number}</option>
            ))}
          </select>
        </label>
        <label>Recipient account number
          <input type="text" placeholder="NX0000000000" autoComplete="off"
            value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
        <label>Amount (ETB)
          <input type="text" inputMode="decimal" placeholder="0.00"
            value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !device}>
          {device ? `Pay via ${device.name}` : "Select a device first"}
        </button>
        <p className="error" role="alert">{error}</p>
      </form>

      <p className="note">
        The device you pick is recorded on the payment. The money itself moves between Nexus accounts, like a transfer.
      </p>
    </section>
  );
}
