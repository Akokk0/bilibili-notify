import { describe, expect, it } from "vite-plus/test";
import { findDevtoolsLeaks, formatReport, MARKERS } from "./check-no-devtools.mjs";

/**
 * 构建后自检:devtools 不许进构建产物。判定是纯函数,拿合成内容红绿跑透;标记本身
 * 「只在 devtools 源码里出现」这一前提由 apps 里的隔离守卫与真构建一起兜着。
 */

const file = (path, content) => ({ path, content });

describe("findDevtoolsLeaks", () => {
	it("干净的产物 → 没问题", () => {
		const files = [file("dist/index.mjs", 'app.route("/api/update", r);\nconst x = "推送";\n')];
		expect(findDevtoolsLeaks(files, MARKERS.server)).toEqual([]);
	});

	it("产物里带着场景 id → 点名文件与标记", () => {
		const files = [
			file("dist/index.mjs", 'const id = "update.state";\n'),
			file("dist/chunk-abc.mjs", "ok\n"),
		];
		expect(findDevtoolsLeaks(files, MARKERS.server)).toEqual([
			{ path: "dist/index.mjs", marker: '"update.state"' },
		]);
	});

	it("web 那一侧认的是面板上的字与 /api/dev 那条路径", () => {
		const files = [file("dist/assets/index-x.js", 'fetch("/api/dev")')];
		expect(findDevtoolsLeaks(files, MARKERS.web)).toEqual([
			{ path: "dist/assets/index-x.js", marker: '"/api/dev"' },
		]);
	});

	it("报告写明是哪份、含什么", () => {
		const text = formatReport([{ path: "dist/index.mjs", marker: "假观众" }]);
		expect(text).toContain("dist/index.mjs");
		expect(text).toContain("假观众");
	});
});
