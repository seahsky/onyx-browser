import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, logout as apiLogout, me, type UserSummary } from "./api";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";

type AuthState = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; user: UserSummary };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const result = await me();
      if (result.kind === "user") {
        setAuth({ status: "signedIn", user: { id: result.id, email: result.email, role: result.role } });
      } else {
        // An API key can't drive this UI — it's a browser session app.
        setAuth({ status: "signedOut" });
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setAuth({ status: "signedOut" });
      } else {
        throw err;
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleLogout = useCallback(async () => {
    await apiLogout();
    setAuth({ status: "signedOut" });
  }, []);

  if (auth.status === "loading") {
    return (
      <main className="centered">
        <p>Loading…</p>
      </main>
    );
  }

  if (auth.status === "signedOut") {
    return <Login onSignedIn={() => void refresh()} />;
  }

  return <Dashboard user={auth.user} onLogout={() => void handleLogout()} />;
}
