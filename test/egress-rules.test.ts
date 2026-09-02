import { describe, expect, it } from "vitest";
import { isDeniedAddress, isDeniedScheme } from "../src/egress/rules.js";

describe("isDeniedScheme", () => {
  it.each(["file:///etc/passwd", "chrome://settings", "devtools://devtools/bundled/inspector.html", "view-source:https://example.com"])(
    "denies %s",
    (url) => {
      expect(isDeniedScheme(url)).toBe(true);
    },
  );

  it.each(["https://example.com", "http://example.com", "about:blank", "data:text/plain,hi", "blob:https://example.com/xyz"])(
    "allows %s",
    (url) => {
      expect(isDeniedScheme(url)).toBe(false);
    },
  );

  it("denies an unparseable URL (fail closed)", () => {
    expect(isDeniedScheme("not a url at all")).toBe(true);
  });
});

describe("isDeniedAddress — IPv4", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["10.255.255.255", "RFC1918 10/8 edge"],
    ["172.16.0.1", "RFC1918 172.16/12"],
    ["172.31.255.255", "RFC1918 172.16/12 edge"],
    ["192.168.0.1", "RFC1918 192.168/16"],
    ["192.168.255.255", "RFC1918 192.168/16 edge"],
    ["169.254.0.1", "link-local"],
    ["169.254.169.254", "cloud metadata address"],
  ])("denies %s (%s)", (ip) => {
    expect(isDeniedAddress(ip)).toBe(true);
  });

  it.each([
    ["8.8.8.8", "public DNS"],
    ["1.1.1.1", "public DNS"],
    ["93.184.216.34", "public host"],
    ["172.15.255.255", "just below RFC1918 172.16/12"],
    ["172.32.0.0", "just above RFC1918 172.16/12"],
  ])("allows %s (%s)", (ip) => {
    expect(isDeniedAddress(ip)).toBe(false);
  });
});

describe("isDeniedAddress — IPv6", () => {
  it("denies ::1 (loopback)", () => {
    expect(isDeniedAddress("::1")).toBe(true);
  });

  it.each(["fc00::1", "fd00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"])("denies %s (ULA, fc00::/7)", (ip) => {
    expect(isDeniedAddress(ip)).toBe(true);
  });

  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111"])("allows %s (public)", (ip) => {
    expect(isDeniedAddress(ip)).toBe(false);
  });
});

describe("isDeniedAddress — fail-closed on garbage", () => {
  it("denies a string that isn't a valid IP at all", () => {
    expect(isDeniedAddress("not-an-ip")).toBe(true);
  });
});
