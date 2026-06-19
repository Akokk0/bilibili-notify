import { describe, expect, it } from "vite-plus/test";
import { resolveChromePath } from "./puppeteer.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";

describe("resolveChromePath", () => {
	const never = (): boolean => false;
	const always = (): boolean => true;

	it("显式 chromePath 非空 → 原样返回(即使探测器探不到也用,信任 operator 意图)", () => {
		expect(resolveChromePath("/custom/chrome", { exists: never, platform: "darwin" })).toBe(
			"/custom/chrome",
		);
	});

	it("显式空白串 → 视为未配置,回落探测", () => {
		expect(resolveChromePath("   ", { exists: (p) => p === CHROME, platform: "darwin" })).toBe(
			CHROME,
		);
	});

	it("未配置 + darwin: 取候选表第一个存在项(Chrome 优先于 Chromium)", () => {
		expect(resolveChromePath(undefined, { exists: always, platform: "darwin" })).toBe(CHROME);
	});

	it("未配置 + darwin: Chrome 缺失则顺延到 Chromium(锁定候选顺序)", () => {
		expect(
			resolveChromePath(undefined, { exists: (p) => p.includes("Chromium"), platform: "darwin" }),
		).toBe(CHROMIUM);
	});

	it("未配置 + darwin: 候选全不存在 → null(降级文字)", () => {
		expect(resolveChromePath(undefined, { exists: never, platform: "darwin" })).toBeNull();
	});

	it("未配置 + linux: 命中候选", () => {
		expect(
			resolveChromePath(undefined, {
				exists: (p) => p === "/usr/bin/chromium-browser",
				platform: "linux",
			}),
		).toBe("/usr/bin/chromium-browser");
	});

	it("未配置 + win32: 命中候选", () => {
		const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
		expect(resolveChromePath(undefined, { exists: (p) => p === edge, platform: "win32" })).toBe(
			edge,
		);
	});

	it("未知平台 → 无候选表 → null", () => {
		expect(
			resolveChromePath(undefined, { exists: always, platform: "freebsd" as NodeJS.Platform }),
		).toBeNull();
	});
});
