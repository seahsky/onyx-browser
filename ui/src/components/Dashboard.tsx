import type { UserSummary } from "../api";
import { KeysPanel } from "./KeysPanel";
import { SessionsPanel } from "./SessionsPanel";

export function Dashboard({ user, onLogout }: { user: UserSummary; onLogout: () => void }) {
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Onyx</h1>
        <div className="dashboard-header-user">
          <span>
            {user.email} <span className="role-badge">{user.role}</span>
          </span>
          <button type="button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="dashboard-body">
        <SessionsPanel />
        <KeysPanel />
      </main>
    </div>
  );
}
