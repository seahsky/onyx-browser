import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, createSession, listSessions, releaseSession, type SessionSummary } from "../api";
import { Viewer } from "./Viewer";

export function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load sessions.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const created = await createSession();
      setSelectedId(created.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create session.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRelease(id: string) {
    setError(null);
    try {
      await releaseSession(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to release session.");
    }
  }

  return (
    <section className="card panel" aria-label="Browser sessions">
      <h2>Sessions</h2>

      <button type="button" onClick={() => void handleCreate()} disabled={creating}>
        {creating ? "Starting…" : "New session"}
      </button>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {sessions === null ? (
        <p>Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="empty">No sessions yet.</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id} className={session.id === selectedId ? "selected" : ""}>
              <span className={`status-badge status-${session.status}`}>{session.status}</span>
              <span className="session-id">{session.id}</span>
              {session.status === "running" && (
                <button type="button" onClick={() => setSelectedId(session.id)}>
                  View
                </button>
              )}
              {(session.status === "running" || session.status === "starting") && (
                <button type="button" onClick={() => void handleRelease(session.id)}>
                  Release
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {selectedId && <Viewer sessionId={selectedId} onClose={() => setSelectedId(null)} />}
    </section>
  );
}
