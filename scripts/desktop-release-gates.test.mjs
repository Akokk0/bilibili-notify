import { describe, expect, it } from "vite-plus/test";
import { parseDesktopLayout } from "./desktop-layout.mjs";
import {
	auditDesktopGates,
	auditRepoDesktopGates,
	readShellLayout,
} from "./desktop-release-gates.mjs";

/**
 * 见 desktop-release-gates.mjs 顶部:桌面产物的布局有四个消费者,其中三个现在读同一份
 * 声明,只有外壳(Rust)留了字面量。这份守卫让「有人和声明说的不是同一套」在本地就红,
 * 而不是等到打 tag —— macOS 那条闸只查文件存在,落后了照样绿。
 *
 * 判定先用合成文本红绿跑透,最后对真实仓库跑一发。
 */

const LAYOUT = parseDesktopLayout(
	JSON.stringify({
		serverDir: "app/apps/server",
		libDir: "lib",
		entry: "boot.mjs",
		webDistDir: "web-dist",
		passesWebDistFlag: false,
		requiredUnderResources: [
			"app/apps/server/lib/boot.mjs",
			"app/apps/server/lib/web-dist/index.html",
		],
		nodeBinary: { macos: "node/bin/node", windows: "node/bin/node.exe" },
	}),
);

const mainRsBoot = `
        let server_entry = server_dir.join("lib").join("boot.mjs");
        let web_dist = server_dir.join("lib").join("web-dist");
        if node.is_file() && server_entry.is_file() && web_dist.join("index.html").is_file() {
`;

/** 一份「照规矩办」的闸脚本:读声明,自己不抄路径。 */
const gateReadingLayout = `
$layout = Get-Content -LiteralPath "apps/desktop/layout.json" -Raw | ConvertFrom-Json
$required = @($layout.requiredUnderResources | ForEach-Object { "resources/$_" })
`;

/** 一份「照规矩办」的生产端:import 声明,不写死目录名。 */
const producerReadingLayout = `
import { readDesktopLayoutFile } from "../../../scripts/desktop-layout.mjs";
await copyFileOrDir(webDist, join(serverRoot, layout.libDir, layout.webDistDir));
`;

describe("parseDesktopLayout", () => {
	it("requiredUnderResources 与 serverDir/libDir/entry 对不上 → 抛", () => {
		const drifted = JSON.stringify({
			serverDir: "app/apps/server",
			libDir: "lib",
			entry: "boot.mjs",
			webDistDir: "web-dist",
			// 入口改成了 boot.mjs,清单还停在 index.mjs —— 声明自己就不自洽了。
			requiredUnderResources: [
				"app/apps/server/lib/index.mjs",
				"app/apps/server/lib/web-dist/index.html",
			],
			nodeBinary: { macos: "node/bin/node", windows: "node/bin/node.exe" },
		});

		expect(() => parseDesktopLayout(drifted)).toThrow(/boot\.mjs/);
	});
});

describe("readShellLayout", () => {
	it("从 main.rs 读出入口、lib 目录、dashboard 位置、以及是否还传 --web-dist", () => {
		expect(readShellLayout(mainRsBoot)).toEqual({
			libDir: "lib",
			entry: "boot.mjs",
			webDistDir: "web-dist",
			passesWebDistFlag: false,
		});
	});

	it("main.rs 换了写法 → 抛出来,而不是静默放过", () => {
		expect(() => readShellLayout("fn main() {}")).toThrow(/main.rs/);
	});
});

describe("auditDesktopGates", () => {
	it("外壳与声明一致、两个闸都读声明 → 没问题", () => {
		expect(
			auditDesktopGates({
				mainRs: mainRsBoot,
				windows: gateReadingLayout,
				macos: gateReadingLayout,
				producer: producerReadingLayout,
				layout: LAYOUT,
			}),
		).toEqual([]);
	});

	// 生产端以前**一次都没被审过**:它把 web-dist 挪个地方,外壳和两个闸全绿,
	// 而用户拿到的包起不来 —— 只有打 tag 那天才知道。
	it("生产端自己写死目录名 → 点名(摆文件的和找文件的必须同源)", () => {
		const hardcoded = `await copyFileOrDir(webDist, join(serverRoot, "lib", "web-dist"));`;
		const problems = auditDesktopGates({
			mainRs: mainRsBoot,
			windows: gateReadingLayout,
			macos: gateReadingLayout,
			producer: hardcoded,
			layout: LAYOUT,
		});

		expect(problems).toEqual([
			"producer: 没有读那份布局声明 —— 摆文件的和找文件的必须同源",
			`producer: 又把 "web-dist" 写死了,应该从 apps/desktop/layout.json 读`,
		]);
	});

	// 这条是这个文件存在的理由:2026-09-02 那次外壳改跑 boot.mjs、dashboard 挪到 lib/web-dist,
	// 两份闸脚本一行没动,本地门禁全绿,只有打 tag 那天 Windows 那条会红。
	it("闸脚本自己抄了一份路径(而且是旧的)→ 逐条点名", () => {
		const stale = `
$serverEntry = Join-Path $serverDir "lib/index.mjs"
$required = @("resources/app/apps/server/lib/index.mjs")
foreach ($arg in @($ServerEntry, "--web-dist", $WebDist)) {
`;
		const problems = auditDesktopGates({
			mainRs: mainRsBoot,
			windows: stale,
			macos: stale,
			producer: producerReadingLayout,
			layout: LAYOUT,
		});

		expect(problems.filter((p) => p.startsWith("windows"))).toHaveLength(3);
		expect(problems.filter((p) => p.startsWith("macos"))).toHaveLength(3);
		expect(problems.join("\n")).toContain("--web-dist");
		expect(problems.join("\n")).toContain("layout.json");
	});

	it("外壳改了入口但声明没跟 → 点名 main.rs(它是唯一读不到声明的那个)", () => {
		const problems = auditDesktopGates({
			mainRs: mainRsBoot.replace("boot.mjs", "index.mjs"),
			windows: gateReadingLayout,
			macos: gateReadingLayout,
			producer: producerReadingLayout,
			layout: LAYOUT,
		});

		expect(problems).toEqual(["main.rs: 外壳起 index.mjs,声明写的是 boot.mjs"]);
	});

	it("外壳又开始传 --web-dist 而声明说不传 → 点名", () => {
		const problems = auditDesktopGates({
			mainRs: `${mainRsBoot}\n args.push("--web-dist");`,
			windows: gateReadingLayout,
			macos: gateReadingLayout,
			producer: producerReadingLayout,
			layout: LAYOUT,
		});

		expect(problems.join("\n")).toContain("--web-dist");
	});

	it("注释里解释「为什么不传 --web-dist」不算传了 —— 只看代码", () => {
		const commented = `# 不传 --web-dist,dashboard 按入口就近找\n${gateReadingLayout}`;
		expect(
			auditDesktopGates({
				mainRs: mainRsBoot,
				windows: commented,
				macos: commented,
				producer: producerReadingLayout,
				layout: LAYOUT,
			}),
		).toEqual([]);
	});
});

describe("真实仓库", () => {
	it("外壳、两个发版闸、与那份布局声明说的是同一套", () => {
		expect(auditRepoDesktopGates()).toEqual([]);
	});
});
