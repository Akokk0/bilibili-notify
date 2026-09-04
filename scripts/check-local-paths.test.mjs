import { describe, expect, it } from "vite-plus/test";
import { ALLOW_MARKER, findLocalPaths, formatReport } from "./check-local-paths.mjs";

/**
 * pre-commit 守卫:本机绝对路径(macOS / Linux / Windows 的家目录)不许进仓库。
 * 2026-08-27 一条写死的 checkout 路径混进 blive 的探针脚本,搬家后它静默读旧目录的
 * 登录态,直到 09-04 才被巡查照出来。判定逻辑是纯函数,拿合成内容红绿跑透。
 */

const file = (path, content) => ({ path, content });

describe("findLocalPaths", () => {
	it("干净的内容 → 没问题", () => {
		expect(findLocalPaths([file("a.ts", 'const x = "apps/server/data";\n')])).toEqual([]);
	});

	it("macOS 家目录路径 → 点名文件与行号", () => {
		const content = 'import x from "y";\nconst root = "/Users/someone/proj/repo";\n'; // local-path-ok
		expect(findLocalPaths([file("scripts/probe.ts", content)])).toEqual([
			{ path: "scripts/probe.ts", line: 2, text: 'const root = "/Users/someone/proj/repo";' }, // local-path-ok
		]);
	});

	it("Linux 与 Windows 家目录路径同样拦", () => {
		const linux = 'const f = "/home/someone/fonts/x.woff2";'; // local-path-ok
		const win = 'const f = "C:\\Users\\someone\\Desktop\\bg.png";'; // local-path-ok
		expect(findLocalPaths([file("a.ts", `${linux}\n${win}\n`)]).map((p) => p.line)).toEqual([1, 2]);
	});

	// Windows 有盘符打头,裸的家目录(后面没有下一层)也拦:USERPROFILE 这类夹具就长这样。
	it("裸的 Windows 家目录也拦", () => {
		const content = 'env("USERPROFILE", r"C:\\Users\\someone");'; // local-path-ok
		expect(findLocalPaths([file("a.rs", content)]).map((p) => p.line)).toEqual([1]);
	});

	// 路由串 `/home/settings`、`/users/:id` 这种不是家目录:没有「用户名/」那一段。
	it("形似的路由串不误伤", () => {
		const content = 'route("/home/settings");\nroute("/users/:id/");\nconst u = "/home";\n';
		expect(findLocalPaths([file("a.ts", content)])).toEqual([]);
	});

	// 中文注释里「/home/xxx、/Users/yyy」这种列举:顿号 / 逗号 / 句号不会出现在用户名里,
	// 别把紧随其后的下一段当成路径的延续。
	it("紧跟中文标点的段不当家目录", () => {
		const content = "// 见 /home/settings、/users/:id 两条,以及 /home/x。\n";
		expect(findLocalPaths([file("a.ts", content)])).toEqual([]);
	});

	// rustfmt 会把超宽行尾的注释挪到上一行去,所以标记写在紧挨着的上一行也算数。
	it(`上一行是 ${ALLOW_MARKER} 标记 → 放行`, () => {
		const content = `// ${ALLOW_MARKER}\nassert_eq!(args, vec![r"C:\\Users\\someone\\AppData"]);\n`;
		expect(findLocalPaths([file("main.rs", content)])).toEqual([]);
	});

	// 清洗函数的测试夹具、这份守卫自己的说明,都合法地含家目录路径:行内标记放行。
	it(`带 ${ALLOW_MARKER} 标记的行放行`, () => {
		const content = `const fixture = "/home/me/fonts/x.woff2"; // ${ALLOW_MARKER}\n`; // local-path-ok
		expect(findLocalPaths([file("a.test.ts", content)])).toEqual([]);
	});
});

describe("formatReport", () => {
	it("没问题 → 空串", () => {
		expect(formatReport([])).toBe("");
	});

	it("每条问题一行 path:line,末尾告诉人怎么放行", () => {
		const report = formatReport([
			{ path: "scripts/probe.ts", line: 2, text: 'const root = "/Users/someone/repo/";' }, // local-path-ok
		]);
		expect(report).toContain("scripts/probe.ts:2");
		expect(report).toContain('const root = "/Users/someone/repo/";'); // local-path-ok
		expect(report).toContain(ALLOW_MARKER);
	});
});
