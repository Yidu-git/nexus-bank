import { useState } from "react";
import { api, setToken } from "./api.js";
import { FingerprintSetup } from "./Fingerprint.jsx";

export default function Auth({ onSignedIn }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(null); // new customer who still has to add a fingerprint

  const register = mode === "register";
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const email = form.email.trim();
      if (register) {
        await api("/register", { method: "POST", body: { name: form.name, email, password: form.password } });
      }
      const res = await api("/login", { method: "POST", body: { email, password: form.password } });
      setToken(res.token);
      if (register) setEnrolling(res.user);   // new account -> ask for a fingerprint first
      else onSignedIn(res.user);
    } catch (ex) {
      setError(ex.message);
      setBusy(false);
    }
  };

  if (enrolling) return <FingerprintSetup onDone={() => onSignedIn(enrolling)} />;

  return (
    <main className="auth">
      <section className="auth-card">
        <div className="brand"><span className="logo">N</span> Nexus</div>
        <p className="tagline">Banking that moves with you.</p>

        <div className="tabs">
          <button type="button" className={"tab" + (!register ? " active" : "")}
            onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
          <button type="button" className={"tab" + (register ? " active" : "")}
            onClick={() => { setMode("register"); setError(""); }}>Open account</button>
        </div>

        <form onSubmit={submit}>
          {register && (
            <label>Full name
              <input type="text" autoComplete="name" value={form.name} onChange={set("name")} required />
            </label>
          )}
          <label>Email
            <input type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
          </label>
          <label>Password
            <input type="password" minLength={8} value={form.password} onChange={set("password")}
              autoComplete={register ? "new-password" : "current-password"} required />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {register ? "Create account" : "Sign in"}
          </button>
          <p className="error" role="alert">{error}</p>
        </form>
      </section>
    </main>
  );
}
