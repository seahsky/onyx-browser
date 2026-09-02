export interface ApiErrorBody {
  error: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.error;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    // Only set Content-Type when there's actually a body — Fastify's JSON
    // body parser tries to parse an empty body if told to expect JSON,
    // which 400s bodyless calls like createSession().
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const errorBody: ApiErrorBody =
      body && typeof body === "object" && "message" in body
        ? (body as ApiErrorBody)
        : { error: "unknown", message: response.statusText };
    throw new ApiRequestError(response.status, errorBody);
  }

  return body as T;
}

export interface UserSummary {
  id: string;
  email: string;
  role: "admin" | "user";
}

export type MeResponse = ({ kind: "user" } & UserSummary) | { kind: "apiKey"; keyId: string; scopes: string[] };

export function login(email: string, password: string): Promise<UserSummary> {
  return request("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function logout(): Promise<void> {
  return request("/v1/auth/logout", { method: "POST" });
}

export function me(): Promise<MeResponse> {
  return request("/v1/auth/me");
}

export const API_SCOPES = ["sessions:read", "sessions:write", "cdp:connect"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyMetadata {
  id: string;
  keyId: string;
  label: string;
  scopes: ApiScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKeyMetadata {
  key: string;
}

export function listKeys(): Promise<ApiKeyMetadata[]> {
  return request("/v1/keys");
}

export function createKey(label: string, scopes: ApiScope[]): Promise<CreatedApiKey> {
  return request("/v1/keys", { method: "POST", body: JSON.stringify({ label, scopes }) });
}

export function revokeKey(keyId: string): Promise<void> {
  return request(`/v1/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
}

export type SessionStatus = "starting" | "running" | "releasing" | "released" | "crashed";

export interface SessionSummary {
  id: string;
  status: SessionStatus;
  createdAt: string;
  releasedAt: string | null;
  expiresAt: string;
}

export interface CreatedSession {
  id: string;
  websocketUrl: string;
  viewerUrl: string;
  expiresAt: string;
}

export function listSessions(): Promise<SessionSummary[]> {
  return request("/v1/sessions");
}

export function createSession(): Promise<CreatedSession> {
  return request("/v1/sessions", { method: "POST" });
}

export function releaseSession(id: string): Promise<void> {
  return request(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Same-origin WS URL for the viewer — auth rides on the browser's own cookie. */
export function viewerSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/v1/sessions/${encodeURIComponent(sessionId)}/viewer`;
}
