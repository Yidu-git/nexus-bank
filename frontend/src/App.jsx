import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api.js";
import Landing from "./Landing.jsx";
import Dashboard from "./Dashboard.jsx";
import { applyTheme, getTheme } from "./theme.js";

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(Boolean(getToken()));
  const [theme, setTheme] = useState(getTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const signOutLocal = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOutLocal);
  }, [signOutLocal]);

  // Restore an existing session on page load.
  useEffect(() => {
    if (!getToken()) return;
    api("/me")
      .then(setUser)
      .catch(signOutLocal)
      .finally(() => setBooting(false));
  }, [signOutLocal]);

  const handleLogout = async () => {
    try { await api("/logout", { method: "POST" }); } catch { /* ignore */ }
    signOutLocal();
    window.scrollTo(0, 0);
  };

  if (booting) return null;
  if (!user) return <Landing onSignedIn={setUser} />;
  return <Dashboard user={user} onLogout={handleLogout} theme={theme} onTheme={setTheme} />;
}
