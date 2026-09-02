export const API_SCOPES = ["sessions:read", "sessions:write", "cdp:connect"] as const;

export type ApiScope = (typeof API_SCOPES)[number];
