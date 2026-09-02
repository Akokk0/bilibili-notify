import { describe, expect, it } from "vite-plus/test";
import {
	auditDesktopGates,
	auditRepoDesktopGates,
	readDesktopLayout,
} from "./desktop-release-gates.mjs";

/**
 * 见 desktop-release-gates.mjs 顶部:桌面发版闸是外壳布局的手写复制品,布局一挪它就
 * 落后。这份守卫让「闸脚本与外壳说的不是同一套布局」在本地就红,而不是等到打 tag。
 *
 * 判定先用合成文本红绿跑透,最后对真实仓库跑一发。
 */

const mainRsBoot = `
        let server_entry = server_dir.join("lib").join("boot.mjs");
        let web_dist = server_dir.join("lib").join("web-dist");
        if node.is_file() && server_entry.is_file() && web_dist.join("index.html").is_file() {
`;

const windowsOk = `
$serverEntry = Join-Path $serverDir "lib/boot.mjs"
$required = @(
    "resources/app/apps/server/lib/boot.mjs",
    "resources/app/apps/server/lib/web-dist/index.html"
)
`;

const macosOk = `
	for rel in node/bin/node app/apps/server/lib/boot.mjs app/apps/server/lib/web-dist/index.html BUILD_INFO.json; do
`;

describe("readDesktopLayout", () => {
	it("从 main.rs 读出入口、dashboard 位置、以及是否还传 --web-dist", () => {
		expect(readDesktopLayout(mainRsBoot)).toEqual({
			entry: "boot.mjs",
			webDist: "lib/web-dist",
			passesWebDistFlag: false,
		});
	});

	it("main.rs 换了写法 → 抛出来,而不是静默放过", () => {
		expect(() => readDesktopLayout("fn main() {}")).toThrow(/main.rs/);
	});
});

describe("auditDesktopGates", () => {
	it("两份闸脚本都照着外壳的布局写 → 没问题", () => {
		expect(auditDesktopGates({ mainRs: mainRsBoot, windows: windowsOk, macos: macosOk })).toEqual(
			[],
		);
	});

	// 这条是这个文件存在的理由:2026-09-02 那次外壳改跑 boot.mjs、dashboard 挪到 lib/web-dist,
	// 两份闸脚本一行没动,本地门禁全绿,只有打 tag 那天 Windows 那条会红。
	it("闸脚本还按老布局写(index.mjs + --web-dist 指向已不存在的目录)→ 逐条点名", () => {
		const windowsStale = `
$serverEntry = Join-Path $serverDir "lib/index.mjs"
$webDist = Join-Path $resourcesDir "app/apps/web/dist"
$required = @(
    "resources/app/apps/server/lib/index.mjs"
)
foreach ($arg in @($ServerEntry, "--web-dist", $WebDist)) {
`;
		const macosStale = `
	for rel in node/bin/node app/apps/server/lib/index.mjs BUILD_INFO.json; do
`;
		const problems = auditDesktopGates({
			mainRs: mainRsBoot,
			windows: windowsStale,
			macos: macosStale,
		});
		expect(problems.filter((p) => p.startsWith("windows"))).toHaveLength(4);
		expect(problems.filter((p) => p.startsWith("macos"))).toHaveLength(2);
		expect(problems.join("\n")).toContain("--web-dist");
		expect(problems.join("\n")).toContain("冒烟起的是 lib/index.mjs");
	});

	it("注释里解释「为什么不传 --web-dist」不算传了 —— 只看代码", () => {
		const windowsCommented = `# 不传 --web-dist,dashboard 按入口就近找\n${windowsOk}`;
		const macosCommented = `\t# 与外壳一致:不再传 --web-dist\n${macosOk}`;
		expect(
			auditDesktopGates({ mainRs: mainRsBoot, windows: windowsCommented, macos: macosCommented }),
		).toEqual([]);
	});

	it("Windows 冒烟起的入口与外壳不同 → 单独点名(文件在场不等于测对了东西)", () => {
		const windowsWrongSmoke = windowsOk.replace(
			'Join-Path $serverDir "lib/boot.mjs"',
			'Join-Path $serverDir "lib/index.mjs"',
		);
		const problems = auditDesktopGates({
			mainRs: mainRsBoot,
			windows: windowsWrongSmoke,
			macos: macosOk,
		});
		expect(problems).toEqual(["windows: 冒烟起的是 lib/index.mjs,外壳起的是 lib/boot.mjs"]);
	});
});

describe("真实仓库", () => {
	it("两份桌面发版闸与 main.rs 说的是同一套布局", () => {
		expect(auditRepoDesktopGates()).toEqual([]);
	});
});
