import { describe, expect, it } from "vite-plus/test";
import { loginQrImageSrc, loginResponseSummary } from "./login";

const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const TEXT_BASE64 = "SGVsbG8sIHRoaXMgaXMgbm90IGFuIGltYWdlIGJ1dCBsb25nIGVub3VnaC4=";

describe("loginQrImageSrc", () => {
	it("uses QR data URLs directly", () => {
		expect(loginQrImageSrc("data:image/png;base64,QR_BASE64")).toBe(
			"data:image/png;base64,QR_BASE64",
		);
	});

	it("wraps raw image base64 QR payloads as PNG data URLs", () => {
		expect(loginQrImageSrc(PNG_BASE64)).toBe(`data:image/png;base64,${PNG_BASE64}`);
	});

	it("does not treat arbitrary login data as an image", () => {
		expect(loginQrImageSrc({ card: { name: "UP" } })).toBeUndefined();
		expect(loginQrImageSrc("https://example.com/qr")).toBeUndefined();
		expect(loginQrImageSrc("hello")).toBeUndefined();
		expect(loginQrImageSrc(TEXT_BASE64)).toBeUndefined();
		expect(loginQrImageSrc("data:image/svg+xml;base64,PHN2Zy8+")).toBeUndefined();
	});
});

describe("loginResponseSummary", () => {
	it("hides QR image payloads from the debug summary", () => {
		expect(loginResponseSummary("data:image/png;base64,QR_BASE64")).toBeUndefined();
	});

	it("keeps non-QR response data inspectable", () => {
		expect(loginResponseSummary({ card: { name: "UP" } })).toContain("UP");
		expect(loginResponseSummary("hello")).toBe('"hello"');
	});
});
