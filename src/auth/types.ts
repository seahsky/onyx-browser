import type { ApiScope } from "./scopes.js";

export type Principal =
  | { kind: "user"; userId: string; sessionId: string; role: "admin" | "user" }
  | { kind: "apiKey"; keyId: string; scopes: ApiScope[] };
