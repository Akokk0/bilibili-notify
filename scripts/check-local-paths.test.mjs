import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ALLOW_MARKER, findLocalPaths, formatReport, readStagedAll } from "./check-local-paths.mjs";

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

	// 裸的家目录(后面没有下一层)也拦:root 只写到用户名、后半段再 join() 拼上,
	// 正是那条探针泄漏被重构一次之后的形状;USERPROFILE 这类夹具也长这样。
	it("裸的家目录也拦,三个平台一致", () => {
		const mac = 'const root = "/Users/someone";'; // local-path-ok
		const linux = 'const root = "/home/someone";'; // local-path-ok
		const win = 'env("USERPROFILE", r"C:\\Users\\someone");'; // local-path-ok
		const lines = findLocalPaths([file("a.rs", `${mac}\n${linux}\n${win}\n`)]).map((p) => p.line);
		expect(lines).toEqual([1, 2, 3]);
	});

	// Windows 路径大小写不敏感,小写盘符与 users 一样是家目录。
	it("小写的 Windows 家目录也拦", () => {
		const content = 'const f = "c:\\users\\someone\\x.png";'; // local-path-ok
		expect(findLocalPaths([file("a.ts", content)]).map((p) => p.line)).toEqual([1]);
	});

	// 路由串 `/users/:id` 是小写、`/home` 后面没有用户名:都不是家目录。
	it("形似的路由串不误伤", () => {
		const content = 'route("/users/:id/");\nconst u = "/home";\nconst v = "/home/";\n';
		expect(findLocalPaths([file("a.ts", content)])).toEqual([]);
	});

	// 中文注释里「/home/、/Users/ 两种」这种列举:顿号 / 逗号 / 句号不会出现在用户名里,
	// 别把紧随其后的下一段当成用户名。
	it("紧跟中文标点的段不当用户名", () => {
		const content = "// 家目录形如 /Users/、/home/ 两种,别写死。\n";
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

/**
 * 读暂存区那一步:一次 `git cat-file --batch` 读全部;不在暂存区(已删除)与二进制跳过,
 * git 本身失败要抛 —— 守卫读不到就放行,等于没有守卫。`run` 注入一段合成的 batch 输出。
 */
describe("readStagedAll", () => {
	const blob = (body) =>
		Buffer.concat([Buffer.from(`0123abcd blob ${body.length}\n`), body, Buffer.from("\n")]);
	const missing = (spec) => Buffer.from(`${spec} missing\n`);

	it("按 size 切内容,换行在内容里也不会切错;顺序与传入路径一一对应", () => {
		const run = () => Buffer.concat([blob(Buffer.from("a\n\nb\n")), blob(Buffer.from("c"))]);
		expect(readStagedAll(["x.ts", "y.ts"], run)).toEqual([
			{ path: "x.ts", content: "a\n\nb\n" },
			{ path: "y.ts", content: "c" },
		]);
	});

	it("二进制(含 NUL)与不在暂存区(已删除)的跳过,后面的文件照常读", () => {
		const run = (specs) => {
			expect(specs).toEqual([":a.png", ":gone.ts", ":z.ts"]);
			return Buffer.concat([
				blob(Buffer.from([0x89, 0x50, 0x00])),
				missing(":gone.ts"),
				blob(Buffer.from("ok")),
			]);
		};
		expect(readStagedAll(["a.png", "gone.ts", "z.ts"], run)).toEqual([
			{ path: "z.ts", content: "ok" },
		]);
	});

	it("没有文件 → 不跑 git", () => {
		expect(
			readStagedAll([], () => {
				throw new Error("不该被调用");
			}),
		).toEqual([]);
	});

	it("git 失败或输出截断 → 抛,不放行", () => {
		const boom = new Error("git cat-file failed");
		expect(() =>
			readStagedAll(["a.ts"], () => {
				throw boom;
			}),
		).toThrow(boom);
		expect(() => readStagedAll(["a.ts"], () => Buffer.from("0123abcd blob 5\nab"))).toThrow(
			/截断|看不懂/,
		);
	});
});

/**
 * 对真实仓库跑一发:pre-commit 只在本地 hook 里跑,`--no-verify`、没装 hooks 的贡献者、网页上
 * 直接改文件都绕得过它;挂在测试里,`vp test` 一步就带上,三条发布路径共用的门禁自然覆盖。
 */
describe("真实仓库", () => {
	it("已跟踪的文本文件里没有本机绝对路径", () => {
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const paths = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: Infinity })
			.toString("utf8")
			.split("\0")
			.filter(Boolean);
		const files = [];
		for (const path of paths) {
			let buf;
			try {
				buf = readFileSync(resolve(repoRoot, path));
			} catch {
				continue; // 工作树里刚删掉、还没提交的
			}
			if (buf.includes(0)) continue;
			files.push({ path, content: buf.toString("utf8") });
		}
		expect(files.length).toBeGreaterThan(100);
		expect(formatReport(findLocalPaths(files))).toBe("");
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
