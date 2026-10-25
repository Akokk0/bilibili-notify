import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_CODES } from "../packages/internal/src/result.ts";

/**
 * 守卫「错误体」(ADR-0026 决策 6,记账式,仿守卫 2 —— 见 network-guard.mjs):vitest 运行里,
 * 服务端代码造出来的每个 HTTP 非 2xx 回应,体都得是平铺的 `{ code, message }`,附加只有
 * `issues` / `upstreamCode`(规矩见 docs/agents/conventions/failure-results.md 规矩 7)。
 * 不合的记账,每条测试收尾查账 —— 现有的路由测试就是驱动,不用另写。
 *
 * **为什么挂在全局 `Response` 上**:Hono 的 `c.json` / `c.text` / `c.body` 最终都落到
 * `new Response(...)`,一个口子管住所有路由(还有不经 Hono 的,如拓展挂载点的 `Response.json`)。
 * 不扫源码:扫 `c.json(` 看不准状态码,也看不见 helper 里造的。换成「测试的 app 外包一层」则要求
 * 每个测试都改用包装,漏一个就漏一片。
 *
 * **谁造的**按构造那一刻的调用栈归属:自上而下第一个项目帧(跳过 Node 内部、node_modules 与守卫
 * 自己)若落在服务端源码里(非测试),就是「我们的服务端代码造的」,才记账。第一个项目帧是测试文件
 * 的(测试自己造的假回应,哪怕再往下有服务端帧在调它给的 mock)、是拓展或别的包的、或者根本没有
 * 项目帧的,一律不管。
 *
 * 已知的漏判见文末 `errorBodyGuard` 的注释。
 */

/** 附加格清单(封闭):要加别的先问主人。 */
const TOP_KEYS = new Set(["code", "message", "issues", "upstreamCode"]);
/** 一条原因的键:`op` 只有拓展设置那处带(第几步惹出来的,ADR-0026 决策 6)。 */
const ISSUE_KEYS = new Set(["path", "message", "op"]);

// 不用 `new URL("..", import.meta.url)`:jsdom 环境里全局 URL 是 jsdom 的,fileURLToPath 不认它的实例。
const REPO_ROOT = `${slash(resolve(dirname(fileURLToPath(import.meta.url)), "..")).replace(/\/$/, "")}/`;
const SERVER_ROOT_ENV = "BN_ERROR_BODY_GUARD_SERVER_ROOT";

function slash(p) {
	return p.replaceAll("\\", "/");
}

// ---- 判据 ---------------------------------------------------------------------------------

/**
 * 一份回应体合不合规,返回问题清单(空 = 合规)。
 * `text` 是体的文本;JSON 必须是对象,`code` 在标准码表里,`message` 是非空字符串,
 * 键只许 `code` / `message` / `issues` / `upstreamCode`,不许有 `ok`。
 */
export function checkErrorBody(text) {
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return [text.trim() === "" ? "回应体是空的" : "回应体不是 JSON"];
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return ["回应体是 JSON,但不是对象"];
	}
	const problems = [];
	if ("ok" in body) problems.push("不许带 ok:非 2xx 的错误体是 Failure 去掉 ok");
	if (typeof body.code !== "string") {
		problems.push("缺 code(要是字符串)");
	} else if (!Object.hasOwn(FAILURE_CODES, body.code)) {
		problems.push(`code「${body.code}」不在标准码表里`);
	}
	if (typeof body.message !== "string" || body.message.trim() === "") {
		problems.push("message 要是非空字符串");
	}
	const extra = Object.keys(body).filter((k) => k !== "ok" && !TOP_KEYS.has(k));
	if (extra.length > 0)
		problems.push(`多余的键:${extra.join("、")}(附加只许 issues / upstreamCode)`);
	if ("upstreamCode" in body) {
		const u = body.upstreamCode;
		if (typeof u !== "number" && typeof u !== "string") {
			problems.push("upstreamCode 要是数字或字符串");
		}
	}
	if ("issues" in body) problems.push(...checkIssues(body.issues));
	return problems;
}

function checkIssues(issues) {
	if (!Array.isArray(issues)) return ["issues 要是数组"];
	const problems = [];
	issues.forEach((item, i) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			problems.push(`issues[${i}] 不是对象`);
			return;
		}
		if (typeof item.message !== "string") problems.push(`issues[${i}].message 要是字符串`);
		if (
			"path" in item &&
			!(
				Array.isArray(item.path) &&
				item.path.every((s) => typeof s === "string" || typeof s === "number")
			)
		) {
			problems.push(`issues[${i}].path 要是 (string | number)[]`);
		}
		if ("op" in item && typeof item.op !== "number") problems.push(`issues[${i}].op 要是数字`);
		const extra = Object.keys(item).filter((k) => !ISSUE_KEYS.has(k));
		if (extra.length > 0) problems.push(`issues[${i}] 多余的键:${extra.join("、")}`);
	});
	return problems;
}

/**
 * 读 `new Response(body, …)` 的第一个参数。字符串、字节、空当场读得出;流 / Blob / FormData 读不出
 * (读它是异步的,构造那一刻等不了),标明是什么。
 */
export function readBody(body) {
	if (body === undefined || body === null) return { text: "" };
	if (typeof body === "string") return { text: body };
	const decoder = new TextDecoder();
	if (body instanceof ArrayBuffer) return { text: decoder.decode(body) };
	if (ArrayBuffer.isView(body)) {
		return { text: decoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
	}
	if (body instanceof URLSearchParams) return { text: body.toString() };
	if (typeof body === "object") {
		const name = body?.constructor?.name;
		if (typeof body.getReader === "function" || typeof body[Symbol.asyncIterator] === "function") {
			return { opaque: name && name !== "Object" ? name : "stream" };
		}
		if (typeof Blob !== "undefined" && body instanceof Blob) return { opaque: "Blob" };
		if (typeof FormData !== "undefined" && body instanceof FormData) return { opaque: "FormData" };
	}
	return { text: String(body) };
}

// ---- 归属 ---------------------------------------------------------------------------------

/** `at fn (path:line:col)` / `at path:line:col` / `at async fn (file:///path:line:col)` → 路径与行。 */
function parseFrame(line) {
	const m =
		/\((.+):(\d+):(\d+)\)\s*$/.exec(line) ?? /^\s*at (?:async )?(.+):(\d+):(\d+)\s*$/.exec(line);
	if (!m) return null;
	const raw = m[1];
	const path = raw.startsWith("file://") ? fileURLToPath(raw) : raw;
	return { path: slash(path), line: Number(m[2]) };
}

/** 服务端源码根之下(相对路径)哪些算测试:`__tests__/`、`__mocks__/`、`*.test.*` / `*.spec.*`。 */
function isTestPath(rel) {
	return /(^|\/)(__tests__|__mocks__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/**
 * 栈上第一个项目帧决定归属:落在 `serverRoot` 之下且不是测试文件 → `{ file, line }`(file 是绝对路径);
 * 其余(测试、拓展、别的包、脚本,或一个项目帧都没有)→ null。
 * Node 内部(`node:`)、node_modules 与守卫自己的帧不算项目帧,跳过。
 */
export function findOwner(stack, { serverRoot }) {
	const root = `${slash(serverRoot).replace(/\/$/, "")}/`;
	for (const text of stack.split("\n").slice(1)) {
		const frame = parseFrame(text);
		if (!frame) continue;
		const { path } = frame;
		if (path.startsWith("node:") || path.includes("/node_modules/")) continue;
		if (path.endsWith("/scripts/error-body-guard.mjs")) continue;
		if (path.startsWith(root) && !isTestPath(path.slice(root.length))) {
			return { file: path, line: frame.line };
		}
		return null;
	}
	return null;
}

// ---- 账本 ---------------------------------------------------------------------------------

function summarize(read) {
	if (read.opaque) return `(${read.opaque},当场读不出内容)`;
	const oneLine = read.text.replace(/\s+/g, " ").trim();
	if (oneLine === "") return "(空)";
	return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

/**
 * 账本:`observe` 收一个回应(状态码、体的初始化参数、构造处的调用栈),≥ 400 且归服务端代码、
 * 体不合规就记一笔 —— 服务端的每个文件一视同仁,没有白名单;`drain` 交出账并清空。
 * 与 `Response` 的挂接分开,好单测。
 */
export function createErrorBodyLedger({ repoRoot = REPO_ROOT, serverRoot }) {
	const entries = [];
	const root = `${slash(repoRoot).replace(/\/$/, "")}/`;
	return {
		observe({ status, body, stack }) {
			if (typeof status !== "number" || !(status >= 400)) return;
			const owner = findOwner(stack, { serverRoot });
			if (!owner) return;
			const file = owner.file.startsWith(root) ? owner.file.slice(root.length) : owner.file;
			const read = readBody(body);
			const problems = read.opaque
				? [`回应体是 ${read.opaque},当场读不出来 —— 非 2xx 的体必须是 JSON 字符串`]
				: checkErrorBody(read.text);
			if (problems.length === 0) return;
			entries.push({ file, line: owner.line, status, body: summarize(read), problems });
		},
		/** 守卫自己出错也要看得见:吞掉了守卫就白挂了。 */
		fault(err) {
			entries.push({
				file: "scripts/error-body-guard.mjs",
				line: 0,
				status: 0,
				body: "(守卫自己出错了)",
				problems: [err instanceof Error ? (err.stack ?? err.message) : String(err)],
			});
		},
		drain: () => entries.splice(0),
	};
}

/**
 * 查账:有违规就抛错,点名文件:行、状态码、体的摘要与原因。同一处同样的违规合并成一条并注明次数。
 * 被测代码把回应吞了也照样判红 —— 只要它造过。
 */
export function assertNoErrorBodyViolations(entries) {
	if (entries.length === 0) return;
	const merged = new Map();
	for (const e of entries) {
		const key = `${e.file}:${e.line}|${e.status}|${e.body}`;
		const hit = merged.get(key);
		if (hit) hit.count += 1;
		else merged.set(key, { ...e, count: 1 });
	}
	const lines = [...merged.values()].map((e) =>
		[
			`  - ${e.file}:${e.line}  ${e.status}  ${e.body}${e.count > 1 ? `  ×${e.count}` : ""}`,
			...e.problems.map((p) => `      · ${p}`),
		].join("\n"),
	);
	throw new Error(
		`服务端代码回了不合规的错误体(非 2xx 必须是平铺的 { code, message },经 respondFailure 回;规矩见 docs/agents/conventions/failure-results.md 规矩 7):\n${lines.join("\n")}`,
	);
}

// ---- 挂接 ---------------------------------------------------------------------------------

const GUARD = Symbol.for("bilibili-notify.test-error-body-guard");

/** 栈要看得够深:路由帧在 Response 构造之上隔着 Hono 的三四层。 */
function captureStack() {
	const previous = Error.stackTraceLimit;
	Error.stackTraceLimit = 60;
	try {
		return new Error().stack ?? "";
	} finally {
		Error.stackTraceLimit = previous;
	}
}

/** 服务端源码根:环境变量 `BN_ERROR_BODY_GUARD_SERVER_ROOT`(相对仓库根或绝对路径,接线夹具用),缺省 `apps/server/src`。 */
function serverRootFromEnv() {
	const given = process.env[SERVER_ROOT_ENV];
	if (!given) return `${REPO_ROOT}apps/server/src/`;
	return `${slash(isAbsolute(given) ? given : resolve(REPO_ROOT, given)).replace(/\/$/, "")}/`;
}

/**
 * 本进程的守卫,首次调用时装上:把全局 `Response` 换成 Proxy,`construct` 陷阱里照常构造、再把
 * (状态码, 体, 调用栈)交给账本;静态的 `Response.json()` 不经构造函数,另在 `get` 陷阱里包一层。
 * setupFiles 每个测试文件都会重跑,装过就复用,不叠第二层。
 *
 * 已知的漏判:
 * - `@hono/node-server` 的 `serve()` 会把全局 `Response` 整个换成它自己的轻量类,换掉之后
 *   在同一个 worker 里造的回应不再经过这里(起真 HTTP server 的测试,如 boot / 生命周期 e2e)。
 *   不能把 Proxy 装成不可配置去挡它 —— 它会直接抛错、server 起不来。
 * - 回应体是流 / Blob 的,构造时读不出内容:≥ 400 一律记账(当前服务端没有这种)。
 * - `new Response(res.body, res)` 这种「复制一份已有回应」的(Hono 的 `c.res = …` 会这么做)不查:
 *   原件构造时已经查过了。
 * - 栈归属只认构造那一刻的同步栈:回应若在别处先造好、再由服务端代码原样转出去,归给造它的地方。
 */
export function errorBodyGuard() {
	if (globalThis[GUARD]) return globalThis[GUARD];
	const ledger = createErrorBodyLedger({ serverRoot: serverRootFromEnv() });
	const guard = { drain: ledger.drain };
	globalThis[GUARD] = guard;

	const NativeResponse = globalThis.Response;
	if (typeof NativeResponse !== "function") return guard; // 没有 Response 的环境,无事可挂

	const observe = (status, body) => {
		if (typeof status !== "number" || !(status >= 400)) return;
		try {
			ledger.observe({ status, body, stack: captureStack() });
		} catch (err) {
			ledger.fault(err);
		}
	};

	globalThis.Response = new Proxy(NativeResponse, {
		construct(target, args, newTarget) {
			const response = Reflect.construct(target, args, newTarget);
			const init = args[1];
			// init 是另一个 Response = 复制一份已有的回应:原件造的时候已经查过了。
			if (init !== null && typeof init === "object" && !(init instanceof target)) {
				observe(init.status ?? 200, args[0]);
			}
			return response;
		},
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (prop !== "json" || typeof value !== "function") return value;
			return function json(data, init) {
				const response = Reflect.apply(value, target, [data, init]);
				observe(init?.status ?? 200, JSON.stringify(data));
				return response;
			};
		},
	});
	return guard;
}
