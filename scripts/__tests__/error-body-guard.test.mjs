import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
	assertNoErrorBodyViolations,
	checkErrorBody,
	createErrorBodyLedger,
	findOwner,
	readBody,
} from "../error-body-guard.mjs";

/**
 * 守卫「错误体」(记账式,仿守卫 2):服务端代码造出来的每个非 2xx 回应,体都得是平铺的
 * `{ code, message }`(附加只有 `issues` / `upstreamCode`),不合的记账,每条测试收尾查账。
 * 判据、归属规则、账本是纯函数;「根配置 → setupFiles → 收尾查账」这整条线另起一次 vitest 验。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("判据:什么样的错误体合规", () => {
	it.each([
		["最小的 { code, message }", { code: "not_found", message: "查无此人" }],
		["码表里的每个码都行", { code: "indeterminate", message: "结果不明" }],
		["带 upstreamCode(数字)", { code: "rate_limited", message: "被风控了", upstreamCode: -352 }],
		["带 upstreamCode(字符串)", { code: "unavailable", message: "对端挂了", upstreamCode: "E42" }],
		[
			"带 issues,path 里有字符串和数字",
			{
				code: "invalid",
				message: "格式不对",
				issues: [{ path: ["subs", 0, "uid"], message: "必填" }, { message: "整体不对" }],
			},
		],
		["issues 可以是空数组", { code: "invalid", message: "x", issues: [] }],
		[
			"issue 带 op(拓展设置:第几步惹出来的,ADR-0026 决策 6)",
			{ code: "invalid", message: "x", issues: [{ op: 0, path: ["links"], message: "m" }] },
		],
	])("合规:%s", (_name, body) => {
		expect(checkErrorBody(JSON.stringify(body))).toEqual([]);
	});

	it.each([
		["空体", "", /空/],
		["不是 JSON", "not found", /不是 JSON/],
		["JSON 数组", "[]", /不是对象/],
		["JSON 字符串", '"oops"', /不是对象/],
		["JSON null", "null", /不是对象/],
		[
			"旧形状 { error }",
			'{"error":"internal_error","message":"boom"}',
			/缺 code[\s\S]*多余的键:error/,
		],
		["只有 error 一个键", '{"error":"not_found"}', /缺 code[\s\S]*message[\s\S]*多余的键:error/],
		["带 ok", '{"ok":false,"code":"invalid","message":"x"}', /ok/],
		[
			"code 不在码表里",
			'{"code":"validation_failed","message":"x"}',
			/validation_failed[\s\S]*码表/,
		],
		["code 是数字(平台的码塞进了 code)", '{"code":-352,"message":"x"}', /缺 code/],
		["code 是原型链上的名字", '{"code":"constructor","message":"x"}', /码表/],
		["没有 message", '{"code":"invalid"}', /message/],
		["message 是空串", '{"code":"invalid","message":"  "}', /message/],
		["message 不是字符串", '{"code":"invalid","message":{"zh":"x"}}', /message/],
		[
			"多余的键",
			'{"code":"invalid","message":"x","scope":"a","revision":"r"}',
			/多余的键:scope、revision/,
		],
		["errors 代替了 message", '{"code":"invalid","errors":["a"]}', /message[\s\S]*errors/],
		[
			"upstreamCode 不是数字或字符串",
			'{"code":"unavailable","message":"x","upstreamCode":{"a":1}}',
			/upstreamCode/,
		],
		["issues 不是数组", '{"code":"invalid","message":"x","issues":"bad"}', /issues 要是数组/],
		[
			"issues 里是字符串",
			'{"code":"invalid","message":"x","issues":["bad"]}',
			/issues\[0\] 不是对象/,
		],
		[
			"issue 没有 message",
			'{"code":"invalid","message":"x","issues":[{"path":["a"]}]}',
			/issues\[0\]\.message/,
		],
		[
			"issue 的 path 里有对象",
			'{"code":"invalid","message":"x","issues":[{"path":[{}],"message":"m"}]}',
			/issues\[0\]\.path/,
		],
		[
			"issue 的 path 不是数组",
			'{"code":"invalid","message":"x","issues":[{"path":"a.b","message":"m"}]}',
			/issues\[0\]\.path/,
		],
		[
			"issue 的 op 不是数字",
			'{"code":"invalid","message":"x","issues":[{"op":"0","message":"m"}]}',
			/issues\[0\]\.op/,
		],
		[
			"issue 多余的键(zod 的原始 issue)",
			'{"code":"invalid","message":"x","issues":[{"path":["a"],"message":"m","code":"too_small","minimum":1}]}',
			/issues\[0\] 多余的键:code、minimum/,
		],
	])("违规:%s", (_name, text, expected) => {
		const problems = checkErrorBody(text);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join("\n")).toMatch(expected);
	});
});

describe("读回应体的初始化参数", () => {
	it("字符串、字节、空", () => {
		expect(readBody('{"a":1}')).toEqual({ text: '{"a":1}' });
		expect(readBody(new TextEncoder().encode('{"a":1}'))).toEqual({ text: '{"a":1}' });
		expect(readBody(new TextEncoder().encode('{"a":1}').buffer)).toEqual({ text: '{"a":1}' });
		expect(readBody(null)).toEqual({ text: "" });
		expect(readBody(undefined)).toEqual({ text: "" });
	});

	it("字节视图只读自己那一段,不带出底下 buffer 的其余部分", () => {
		const backing = new TextEncoder().encode('xx{"a":1}yy');
		expect(readBody(new Uint8Array(backing.buffer, 2, 7))).toEqual({ text: '{"a":1}' });
	});

	it("流 / Blob 当场读不出来,标明是什么", () => {
		expect(readBody(new ReadableStream())).toEqual({ opaque: "ReadableStream" });
		expect(readBody(new Blob(["x"]))).toEqual({ opaque: "Blob" });
	});
});

describe("归属:这个回应是谁造的", () => {
	const serverRoot = "/repo/apps/server/src/";
	const stackOf = (...frames) => ["Error", ...frames.map((f) => `    at ${f}`)].join("\n");

	it("栈上第一个项目帧落在服务端源码里(非测试)= 服务端代码造的,点名文件与行", () => {
		const stack = stackOf(
			"guarded (/repo/scripts/error-body-guard.mjs:99:9)",
			"createResponseInstance (/repo/node_modules/.pnpm/hono@4/node_modules/hono/dist/context.js:11:47)",
			"Context.json (/repo/node_modules/.pnpm/hono@4/node_modules/hono/dist/context.js:370:12)",
			"handler (/repo/apps/server/src/routes/subscriptions.ts:88:14)",
			"dispatch (/repo/node_modules/.pnpm/hono@4/node_modules/hono/dist/compose.js:29:23)",
		);
		expect(findOwner(stack, { serverRoot })).toEqual({
			file: "/repo/apps/server/src/routes/subscriptions.ts",
			line: 88,
		});
	});

	it("没有括号的帧、file:// 形式的帧、async 帧都认", () => {
		expect(findOwner(stackOf("/repo/apps/server/src/app.ts:5:6"), { serverRoot })?.file).toBe(
			"/repo/apps/server/src/app.ts",
		);
		expect(
			findOwner(stackOf("async handler (file:///repo/apps/server/src/routes/x.ts:7:8)"), {
				serverRoot,
			})?.line,
		).toBe(7);
	});

	it("第一个项目帧是测试 = 测试造的假回应,哪怕再往下有服务端帧(服务端代码调了测试给的 mock)", () => {
		const stack = stackOf(
			"fakeFetch (/repo/apps/server/src/routes/__tests__/x.test.ts:12:20)",
			"fetchProfile (/repo/apps/server/src/routes/subscriptions.ts:40:10)",
		);
		expect(findOwner(stack, { serverRoot })).toBeNull();
	});

	it.each([
		["__tests__ 里的支撑文件", "/repo/apps/server/src/__tests__/support/track-context.ts:3:4"],
		["测试文件本身", "/repo/apps/server/src/routes/subs.test.ts:3:4"],
		["__mocks__", "/repo/apps/server/src/__mocks__/x.ts:3:4"],
		["拓展自己的路由", "/repo/extensions/bridge/src/routes.ts:3:4"],
		["别的包", "/repo/packages/api/src/client.ts:3:4"],
		["脚本", "/repo/scripts/whatever.mjs:3:4"],
	])("不归服务端:%s", (_name, frame) => {
		const stack = stackOf(frame, "handler (/repo/apps/server/src/routes/subscriptions.ts:88:14)");
		expect(findOwner(stack, { serverRoot })).toBeNull();
	});

	it("栈上没有项目帧(只有 Node 内部与依赖包)= 认不出是谁,不记", () => {
		const stack = stackOf(
			"new Response (node:internal/deps/undici/undici:1:1)",
			"run (/repo/node_modules/.pnpm/vitest@4/node_modules/vitest/dist/x.js:1:1)",
			"Array.map (<anonymous>)",
		);
		expect(findOwner(stack, { serverRoot })).toBeNull();
	});

	it("根目录是可配的,判测试路径按相对根的那一段 —— 根本身在 __tests__ 底下也认", () => {
		const root = "/repo/scripts/__tests__/fixtures/g/server/";
		expect(findOwner(stackOf(`h (${root}routes/bad.mjs:3:4)`), { serverRoot: root })?.file).toBe(
			`${root}routes/bad.mjs`,
		);
		expect(findOwner(stackOf(`h (${root}__tests__/bad.mjs:3:4)`), { serverRoot: root })).toBeNull();
		expect(
			findOwner(stackOf("h (/repo/scripts/__tests__/fixtures/g/wiring.fixture.mjs:3:4)"), {
				serverRoot: root,
			}),
		).toBeNull();
	});

	it("Windows 的反斜杠路径同样认", () => {
		const stack = stackOf("h (C:\\repo\\apps\\server\\src\\routes\\subscriptions.ts:8:9)");
		expect(findOwner(stack, { serverRoot: "C:/repo/apps/server/src/" })?.line).toBe(8);
	});
});

describe("账本", () => {
	const repoRoot = "/repo/";
	const serverRoot = "/repo/apps/server/src/";
	const stackIn = (file) => `Error\n    at handler (/repo/${file}:10:5)`;
	const OLD_SHAPE = JSON.stringify({ error: "boom" });
	const GOOD = JSON.stringify({ code: "invalid", message: "不对" });
	const ledger = () => createErrorBodyLedger({ repoRoot, serverRoot });

	it("服务端代码造的旧形状 4xx / 5xx:记账,带文件:行、状态码、体的摘要", () => {
		const l = ledger();
		l.observe({ status: 500, body: OLD_SHAPE, stack: stackIn("apps/server/src/routes/new.ts") });
		const [entry, ...rest] = l.drain();
		expect(rest).toEqual([]);
		expect(entry).toMatchObject({ file: "apps/server/src/routes/new.ts", line: 10, status: 500 });
		expect(entry.body).toContain("boom");
		expect(entry.problems.length).toBeGreaterThan(0);
		expect(l.drain()).toEqual([]);
	});

	it("合规的体、2xx / 3xx、状态码不是数字:都不记", () => {
		const l = ledger();
		const stack = stackIn("apps/server/src/routes/new.ts");
		l.observe({ status: 400, body: GOOD, stack });
		l.observe({ status: 200, body: OLD_SHAPE, stack });
		l.observe({ status: 302, body: "", stack });
		l.observe({ status: undefined, body: OLD_SHAPE, stack });
		expect(l.drain()).toEqual([]);
	});

	it("非 JSON 的 4xx / 5xx 也算违规", () => {
		const l = ledger();
		l.observe({ status: 404, body: "not found", stack: stackIn("apps/server/src/routes/new.ts") });
		expect(l.drain()).toHaveLength(1);
	});

	it("流 / Blob 当场读不出来:记账,摘要里写明", () => {
		const l = ledger();
		l.observe({
			status: 502,
			body: new ReadableStream(),
			stack: stackIn("apps/server/src/routes/new.ts"),
		});
		const [entry] = l.drain();
		expect(entry.body).toContain("ReadableStream");
	});

	/**
	 * 没有白名单:服务端的每个文件一视同仁。曾经有过一份「还没迁的文件」名单(④b 迁移期),
	 * 迁完就拿掉了 —— 谁再手写旧形状,不论在哪个文件,那条测试都红并点名它。
	 */
	it("服务端的任何文件(含原先迁移期放行过的两个路由)手写旧形状,一样记账", () => {
		const l = ledger();
		for (const file of [
			"apps/server/src/routes/extensions.ts",
			"apps/server/src/routes/extension-settings.ts",
			"apps/server/src/routes/old.ts",
		]) {
			l.observe({ status: 500, body: OLD_SHAPE, stack: stackIn(file) });
		}
		expect(l.drain().map((e) => e.file)).toEqual([
			"apps/server/src/routes/extensions.ts",
			"apps/server/src/routes/extension-settings.ts",
			"apps/server/src/routes/old.ts",
		]);
	});

	it("测试自己造的、拓展造的、认不出是谁造的:不记账", () => {
		const l = ledger();
		l.observe({
			status: 500,
			body: OLD_SHAPE,
			stack: stackIn("apps/server/src/__tests__/x.test.ts"),
		});
		l.observe({ status: 500, body: OLD_SHAPE, stack: stackIn("extensions/bridge/src/routes.ts") });
		l.observe({ status: 500, body: OLD_SHAPE, stack: "Error\n    at node:internal/x:1:1" });
		expect(l.drain()).toEqual([]);
	});

	it("摘要很长时截断,换行折成一行", () => {
		const l = ledger();
		const long = `{"error":"${"x".repeat(500)}\\n${"y".repeat(50)}"}`;
		l.observe({ status: 500, body: long, stack: stackIn("apps/server/src/routes/new.ts") });
		const [entry] = l.drain();
		expect(entry.body.length).toBeLessThan(220);
		expect(entry.body).not.toContain("\n");
	});
});

describe("查账", () => {
	it("账本是空的就放过,有账就抛错,点名文件:行、状态码、体和原因", () => {
		expect(() => assertNoErrorBodyViolations([])).not.toThrow();
		const entry = {
			file: "apps/server/src/routes/subscriptions.ts",
			line: 88,
			status: 400,
			body: '{"error":"invalid_payload"}',
			problems: ["缺 code(字符串)", "多余的键:error"],
		};
		expect(() => assertNoErrorBodyViolations([entry])).toThrow(
			/apps\/server\/src\/routes\/subscriptions\.ts:88[\s\S]*400[\s\S]*invalid_payload[\s\S]*缺 code[\s\S]*多余的键:error/,
		);
	});

	it("同一处同样的违规只列一次,注明次数", () => {
		const entry = {
			file: "apps/server/src/routes/subscriptions.ts",
			line: 88,
			status: 400,
			body: "{}",
			problems: ["缺 code(字符串)"],
		};
		expect(() => assertNoErrorBodyViolations([entry, entry, entry])).toThrow(/×3/);
	});
});

describe("接线", () => {
	// 真起一次 vitest 跑夹具,钉的是「根配置 → setupFiles → 收尾查账」这整条线。夹具不在
	// apps/server/src 底下,靠 test.env 把「服务端源码根」指到夹具目录里的 server/。
	function runFixtures() {
		const outDir = mkdtempSync(join(tmpdir(), "bn-error-body-guard-"));
		try {
			const outputFile = join(outDir, "report.json");
			const env = Object.fromEntries(
				Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")),
			);
			const run = spawnSync(
				"vp",
				[
					"test",
					"--config",
					"scripts/__tests__/fixtures/error-body-guard/vite.config.mjs",
					"--reporter",
					"json",
					"--outputFile",
					outputFile,
				],
				{ cwd: REPO_ROOT, encoding: "utf8", env },
			);
			return { run, report: JSON.parse(readFileSync(outputFile, "utf8")) };
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	it("服务端代码回了旧形状,那条测试判失败、点名文件:行;测试自己造的假回应不受牵连", () => {
		const { run, report } = runFixtures();
		expect(run.status, run.stderr).toBe(1);
		const testNamed = (title) =>
			report.testResults.flatMap((f) => f.assertionResults).find((a) => a.title === title);
		const failedWith = (title, ...needles) => {
			const t = testNamed(title);
			expect(t.status, title).toBe("failed");
			const message = t.failureMessages.join("\n");
			for (const needle of needles) expect(message, title).toContain(needle);
		};
		failedWith("旧形状的 500", "server/routes/legacy-shape.mjs:", "500", '{"error":"boom"}');
		failedWith("Response.json 静态方法造的旧形状", "server/routes/legacy-shape.mjs:", "404");
		failedWith("纯文本的 404", "server/routes/legacy-shape.mjs:", "not found");
		failedWith("体是流的 500", "ReadableStream");

		for (const title of [
			"合规的错误体",
			"2xx 不管",
			"测试文件自己造的假回应",
			"服务端代码调了测试给的 mock",
			"服务端目录里 __tests__ 下造的",
			"复制一份旧回应不重复记账",
			"之后的测试不受牵连",
		]) {
			expect(testNamed(title).status, title).toBe("passed");
		}

		const afterAllFile = report.testResults.find((f) => f.name.endsWith("after-all.fixture.mjs"));
		expect(afterAllFile.status).toBe("failed");
		expect(afterAllFile.message).toContain("server/routes/legacy-shape.mjs:");
	}, 90_000);
});
