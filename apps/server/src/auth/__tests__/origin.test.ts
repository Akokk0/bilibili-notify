import { describe, expect, it } from "vite-plus/test";
import { isOriginAllowed, normalizeAllowedOrigins } from "../origin.js";

describe("normalizeAllowedOrigins", () => {
	it("undefined → []", () => {
		expect(normalizeAllowedOrigins(undefined)).toEqual([]);
	});
	it("drops empty strings", () => {
		expect(normalizeAllowedOrigins(["", "https://a", ""])).toEqual(["https://a"]);
	});
});

describe("isOriginAllowed", () => {
	it("empty allow-list → gate disabled (everything passes, even no Origin)", () => {
		expect(isOriginAllowed(undefined, [])).toBe(true);
		expect(isOriginAllowed("https://evil.example", [])).toBe(true);
	});

	it("configured → only verbatim members pass", () => {
		const allow = ["https://dash.example.com"];
		expect(isOriginAllowed("https://dash.example.com", allow)).toBe(true);
		expect(isOriginAllowed("https://evil.example.org", allow)).toBe(false);
		// No substring / suffix matching — exact string only.
		expect(isOriginAllowed("https://dash.example.com.evil.org", allow)).toBe(false);
		expect(isOriginAllowed("https://dash.example.com:8443", allow)).toBe(false);
	});

	it("configured + missing/blank/non-string Origin → rejected", () => {
		const allow = ["https://dash.example.com"];
		expect(isOriginAllowed(undefined, allow)).toBe(false);
		expect(isOriginAllowed(null, allow)).toBe(false);
		expect(isOriginAllowed("", allow)).toBe(false);
	});
});
