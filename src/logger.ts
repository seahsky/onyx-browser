import pino, { type Logger } from "pino";

/** Strips ?apiKey= from a URL, keeping the rest of the query string intact. */
function redactApiKeyQueryParam(url: string): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;
  const path = url.slice(0, queryIndex);
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  if (!params.has("apiKey")) return url;
  params.set("apiKey", "[redacted]");
  return `${path}?${params.toString()}`;
}

export function createLogger(isProduction: boolean): Logger {
  return pino({
    level: process.env["ONYX_LOG_LEVEL"] ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "*.password",
        "*.passwordHash",
        "*.sessionSecret",
        "*.secret",
        "*.secretHash",
        "*.apiKey",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req(request: { method: string; url: string; id: string | number }) {
        return { method: request.method, url: redactApiKeyQueryParam(request.url), id: request.id };
      },
    },
    ...(isProduction ? {} : { transport: { target: "pino-pretty", options: { colorize: true } } }),
  });
}
