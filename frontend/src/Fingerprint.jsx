import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { cap, formatDate } from "./format.js";
import { Icon } from "./SideMenu.jsx";
import { createFingerprintKey, fingerprintSupported, friendlyError, unsupportedReason } from "./webauthn.js";

// device: "phone"  = the customer's own phone (scan the QR code / use a paired phone)
//         "this"   = the fingerprint reader of the device they're on (Touch ID, or a phone itself)
const deviceLabel = (device) =>
  device === "phone" ? "My phone" : /Mac/i.test(navigator.userAgent) ? "This Mac" : "This device";

// Asks the browser for a fingerprint and saves the resulting key on the server.
export async function enrollFingerprint(device) {
  const options = await api("/fingerprint/register/options", { method: "POST", body: { device } });
  const credential = await createFingerprintKey(options);
  return api("/fingerprint/register/verify", { method: "POST", body: { credential, label: deviceLabel(device) } });
}

/** Shown right after sign-up: "Set up fingerprint pay" (can be skipped and done later). */
export function FingerprintSetup({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const start = async (device) => {
    setError("");
    setBusy(true);
    try {
      await enrollFingerprint(device);
      setDone(true);
    } catch (ex) {
      setError(friendlyError(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <section className="auth-card fp-card">
        <div className="brand"><span className="logo">N</span> Nexus</div>
        <div className={"fp-hero" + (busy ? " scanning" : "") + (done ? " done" : "")}><Icon name="fingerprint" size={64} /></div>
        {done ? (
          <>
            <h2>Fingerprint saved</h2>
            <p className="tagline">Next time you pay at a Nexus terminal, approve with your fingerprint.</p>
            <button className="btn primary" type="button" onClick={onDone}>Continue</button>
          </>
        ) : (
          <>
            <h2>Add your fingerprint</h2>
            <p className="tagline">
              Pay at Nexus businesses by approving with your fingerprint. It stays on your own device &mdash;
              Nexus never sees or stores it.
            </p>
            {!fingerprintSupported && <p className="note fp-warn">{unsupportedReason()}</p>}
            <button className="btn primary" type="button" onClick={() => start("phone")} disabled={busy || !fingerprintSupported}>
              {busy ? "Waiting for your fingerprint…" : "Use my phone’s fingerprint"}
            </button>
            <button className="btn fp-skip" type="button" onClick={() => start("this")} disabled={busy || !fingerprintSupported}>
              Use this device’s fingerprint
            </button>
            <p className="note">With “my phone”, scan the QR code that appears and approve on your phone.</p>
            <button className="btn ghost fp-skip" type="button" onClick={onDone} disabled={busy}>Not now</button>
            <p className="error" role="alert">{error}</p>
          </>
        )}
      </section>
    </main>
  );
}

/** The "Fingerprint Pay" page in the menu: manage fingerprints, pick the account and limit. */
export default function Fingerprint({ accounts, onChanged }) {
  const [info, setInfo] = useState(null);
  const [accountId, setAccountId] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: "", ok: false });

  const load = useCallback(async () => {
    const res = await api("/fingerprint");
    setInfo(res);
    setAccountId(res.account_id ?? "");
    setLimit(String(res.limit));
  }, []);
  useEffect(() => { load().catch((ex) => setMsg({ text: ex.message, ok: false })); }, [load]);

  const add = async (device) => {
    setMsg({ text: "", ok: false });
    setBusy(true);
    try {
      await enrollFingerprint(device);
      await load();
      setMsg({ text: "Fingerprint added.", ok: true });
    } catch (ex) {
      setMsg({ text: friendlyError(ex), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      await api(`/fingerprint/credentials/${id}`, { method: "DELETE" });
      await load();
      setMsg({ text: "Fingerprint removed.", ok: true });
    } catch (ex) {
      setMsg({ text: ex.message, ok: false });
    }
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      await api("/fingerprint/settings", { method: "PUT", body: { account_id: Number(accountId), limit } });
      await load();
      setMsg({ text: "Saved.", ok: true });
      onChanged?.();
    } catch (ex) {
      setMsg({ text: ex.message, ok: false });
    }
  };

  if (!info) return <section className="panel"><p className="muted">Loading…</p></section>;
  const enrolled = info.credentials.length > 0;

  return (
    <>
      <section className="panel">
        <div className="fp-status">
          <span className={"bt-icon" + (busy ? " pulse" : "")}><Icon name="fingerprint" /></span>
          <div>
            <strong>{enrolled ? "Fingerprint Pay is on" : "Fingerprint Pay is off"}</strong>
            <small>{enrolled ? "Approve with your fingerprint at any Nexus payment terminal." : "Add your phone’s fingerprint to pay."}</small>
          </div>
        </div>
        <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
          <button className="btn primary" type="button" onClick={() => add("phone")} disabled={busy || !fingerprintSupported}>
            {busy ? "Waiting…" : enrolled ? "Add another phone" : "Add my phone"}
          </button>
          <button className="btn" type="button" onClick={() => add("this")} disabled={busy || !fingerprintSupported}>
            Add this device
          </button>
        </div>
        {!fingerprintSupported && <p className="note fp-warn">{unsupportedReason()}</p>}

        {enrolled && (
          <ul className="fp-list">
            {info.credentials.map((c) => (
              <li key={c.id}>
                <div>
                  <strong>{c.label}</strong>
                  <small>Added {formatDate(c.created_at)}{c.last_used_at ? ` · last used ${formatDate(c.last_used_at)}` : ""}</small>
                </div>
                <button className="btn ghost" type="button" onClick={() => remove(c.id)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <p className={"error" + (msg.ok ? " ok" : "")} role="alert">{msg.text}</p>
      </section>

      <section className="panel">
        <h2>Payment settings</h2>
        <form onSubmit={save}>
          <label>Pay from
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{cap(a.type)} · {a.number}</option>)}
            </select>
          </label>
          <label>Limit per fingerprint payment (ETB)
            <input type="text" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} required />
          </label>
          <button className="btn primary" type="submit">Save settings</button>
        </form>
        <p className="note">
          A tap can never take more than this limit in one payment. Remove a fingerprint here
          if you lose a device.
        </p>
      </section>
    </>
  );
}
