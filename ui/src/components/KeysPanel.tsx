import { useCallback, useEffect, useState } from "react";
import {
  ApiRequestError,
  API_SCOPES,
  createKey,
  listKeys,
  revokeKey,
  type ApiKeyMetadata,
  type ApiScope,
  type CreatedApiKey,
} from "../api";

export function KeysPanel() {
  const [keys, setKeys] = useState<ApiKeyMetadata[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["sessions:read"]);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setKeys(await listKeys());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load keys.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleScope(scope: ApiScope) {
    setScopes((current) => (current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]));
  }

  async function handleCreate() {
    setError(null);
    if (!label.trim() || scopes.length === 0) {
      setError("A label and at least one scope are required.");
      return;
    }
    try {
      const created = await createKey(label.trim(), scopes);
      setJustCreated(created);
      setLabel("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create key.");
    }
  }

  async function handleRevoke(keyId: string) {
    setError(null);
    try {
      await revokeKey(keyId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to revoke key.");
    }
  }

  return (
    <section className="card panel" aria-label="API keys">
      <h2>API keys</h2>

      {justCreated && (
        <div className="key-reveal">
          <p>Copy this key now — it won&rsquo;t be shown again.</p>
          <code>{justCreated.key}</code>
          <button type="button" onClick={() => setJustCreated(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="key-form">
        <input placeholder="Label (e.g. CI)" value={label} onChange={(event) => setLabel(event.target.value)} />
        <div className="scope-checkboxes">
          {API_SCOPES.map((scope) => (
            <label key={scope}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
              {scope}
            </label>
          ))}
        </div>
        <button type="button" onClick={() => void handleCreate()}>
          Create key
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {keys === null ? (
        <p>Loading…</p>
      ) : keys.length === 0 ? (
        <p className="empty">No API keys yet.</p>
      ) : (
        <ul className="key-list">
          {keys.map((key) => (
            <li key={key.id} className={key.revokedAt ? "revoked" : ""}>
              <span className="key-label">{key.label}</span>
              <span className="key-id">{key.keyId}</span>
              <span className="key-scopes">{key.scopes.join(", ")}</span>
              {key.revokedAt ? (
                <span className="badge">revoked</span>
              ) : (
                <button type="button" onClick={() => void handleRevoke(key.keyId)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
