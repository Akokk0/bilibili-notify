import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import { findNodes, listSources, parseSource, ts } from "../source-scan.mjs";

/**
 * 结果不手写:造结果一律用 `internal` 的 `ok()` / `fail()`,不手写 `{ ok: true, … }` /
 * `{ ok: false, … }` 的对象字面量(失败规矩第 1 条,主人 09-29:都统一、不手写)。
 *
 * 手写的结果会各自长歪:失败原因叫 `err` / `reason` / `errors` / `why`,码是平台的数字,
 * 附加格想加就加。类型、测试、构建全绿,歪的形状一路漏到面板上。
 *
 * - 范围:`apps/<应用>/src`、`packages/<包>/src`、`extensions/<拓展>/src`,不含测试。
 * - 判据看语法树:对象字面量里有一格 `ok`,值是字面量 `true` / `false`(看穿括号、`as`、
 *   `satisfies`)。类型里的 `{ ok: true }`、`ok: res.ok` 这类转抄、注释与字符串都不算。
 * - 白名单只有 `ok()` / `fail()` 所在的那个文件。
 * - 棘轮按文件记上限,对账见 `scripts/ratchet-audit.mjs`:多一处就红,上限高于实数也红。
 *   第 1 期 ④b 开张,第 5 期末清零。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 白名单:整个文件放行,写明理由。 */
export const ALLOWLIST = {
	"packages/internal/src/constants.ts": "ok() / fail() 的定义",
};

/**
 * 棘轮表:文件 → 手写结果的上限(开张时的实数)。只许往下调,第 5 期末清零。
 * 按形状与去向分,清的时候照这张图走:
 *
 * - `{ ok, latencyMs, err }` 投递与探测结果(平台适配器、sink、推送、重推、链接解析回复):
 *   历史里存着投递结果,按 ADR-0026 决策 5 随改盘上形状的那一期改。
 * - `{ ok, errors: string[] }` / `{ ok, error }` 的检查(皮肤、卡片皮肤、zip、额外请求参数):
 *   逐条原因改 `issues`。
 * - `{ ok, reason }` / `{ ok, err }`(应用内更新、拓展市场与清单、女仆技能、头像、正则、
 *   订阅源上报、拓展设置、指令参数):更新的 kebab `reason` 改 snake 码(决策 3),其余改 `code` + `message`。
 * - 面板:登录的 `{ ok, kind, message }` 与 devtools 的几处。
 * - 桥拓展:拓展只能从 `@bilibili-notify/extension` 拿东西,那个包还没有 `ok()` / `fail()`,等 3b 的契约 v3。
 * - 不是结果但带 `ok` 的:AI 工具结束的 SSE 帧。
 * - devtools 假桥发的 `result` 帧:3b 桥协议的回执统一成结果形状后改用 `fail()` 展开(ADR-0026 决策 7)。
 * - `packages/api/src/follow.ts`:B 站的码塞在 `code` 里,3a 随 api 包删掉。
 */
export const RATCHET = {
	"apps/server/src/card-skins/ai-css.ts": 7,
	"apps/server/src/card-skins/html-sanitizer.ts": 5,
	"apps/server/src/card-skins/package.ts": 6,
	"apps/server/src/card-skins/preview-html.ts": 2,
	"apps/server/src/devtools/capture.ts": 1,
	"apps/server/src/devtools/fake-bridge.ts": 3,
	"apps/server/src/devtools/scenarios/bridge.ts": 3,
	"apps/server/src/extensions/marketplace.ts": 14,
	"apps/server/src/extensions/settings-io.ts": 9,
	"apps/server/src/history/repush-runner.ts": 1,
	"apps/server/src/index.ts": 1,
	"apps/server/src/maid-skills/parse.ts": 8,
	"apps/server/src/platforms/onebot.ts": 29,
	"apps/server/src/platforms/qq-official.ts": 21,
	"apps/server/src/platforms/webhook.ts": 5,
	"apps/server/src/routes/ai.ts": 2,
	"apps/server/src/runtime/bootstrap.ts": 1,
	"apps/server/src/runtime/command-params.ts": 4,
	"apps/server/src/push/multiplex.ts": 5,
	"apps/server/src/skins/ai-edit.ts": 3,
	"apps/server/src/skins/package.ts": 5,
	"apps/server/src/skins/schema.ts": 5,
	"apps/server/src/skins/scoped-css.ts": 7,
	"apps/server/src/update/fetch-signed-manifest.ts": 8,
	"apps/server/src/update/fetch-through-mirrors.ts": 2,
	"apps/server/src/update/install-payload.ts": 6,
	"apps/server/src/update/service.ts": 4,
	"apps/server/src/update/signed-manifest.ts": 5,
	"apps/server/src/zip-junk.ts": 3,
	"apps/web/src/devtools/dock.tsx": 2,
	"apps/web/src/devtools/ext-motion.ts": 3,
	"apps/web/src/devtools/web-scenarios.ts": 1,
	"apps/web/src/services/session.ts": 6,
	"extensions/bridge/src/adapter.ts": 12,
	"extensions/bridge/src/blob-route.ts": 1,
	"extensions/bridge/src/protocol.ts": 5,
	"extensions/bridge/src/server.ts": 10,
	"packages/ai/src/extra-params.ts": 5,
	"packages/api/src/follow.ts": 1,
	"packages/internal/src/schema/card-skin.ts": 3,
	"packages/internal/src/schema/extension-manifest.ts": 6,
	"packages/internal/src/schema/extension-marketplace.ts": 8,
	"packages/internal/src/schema/subscription-report.ts": 17,
	"packages/internal/src/util/regex-safety.ts": 4,
	"packages/push/src/bilibili-push.ts": 5,
};

/** 剥掉只改类型、不改值的外壳:括号、`as`、`satisfies`、`<T>x`、`x!`。 */
function unwrapValue(expression) {
	let node = expression;
	while (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node)
	) {
		node = node.expression;
	}
	return node;
}

/** 键是 `ok`:`ok`、`"ok"`、`["ok"]` 三种写法。 */
function isOkKey(name) {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === "ok";
	return (
		ts.isComputedPropertyName(name) &&
		ts.isStringLiteral(name.expression) &&
		name.expression.text === "ok"
	);
}

/** 一个节点是不是手写的结果:对象字面量里有一格 `ok`,值是字面量 `true` / `false`。 */
function isHandWrittenResult(node) {
	if (!ts.isObjectLiteralExpression(node)) return false;
	return node.properties.some((property) => {
		if (!ts.isPropertyAssignment(property) || !isOkKey(property.name)) return false;
		const kind = unwrapValue(property.initializer).kind;
		return kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword;
	});
}

/**
 * 一份源码里手写的结果,一个对象字面量算一处。
 *
 * @returns `{ line, text }[]`,按出现顺序
 */
export function handWrittenResults(source) {
	return findNodes(source, isHandWrittenResult).map(({ line, text }) => ({ line, text }));
}

/** 把一段样例当成一份 `.ts` 源码,返回命中的行号。 */
const linesIn = (text) => handWrittenResults(parseSource("sample.ts", text)).map((h) => h.line);

describe("手写结果的判据:算", () => {
	it("成功与失败两支,带不带别的格都算", () => {
		expect(linesIn(`return { ok: true };`)).toEqual([1]);
		expect(linesIn(`return { ok: true, id };`)).toEqual([1]);
		expect(linesIn(`return { ok: false, code: "invalid", message };`)).toEqual([1]);
		expect(linesIn(`return { ok: false, err: "bot 掉线了" };`)).toEqual([1]);
		expect(linesIn(`const view = { ...base, name, ok: false, err };`)).toEqual([1]);
	});

	it("看穿括号、as、satisfies、非空断言:只改类型不改值", () => {
		expect(linesIn(`return { ok: true as const, id };`)).toEqual([1]);
		expect(linesIn(`return { ok: (false), reason };`)).toEqual([1]);
		expect(linesIn(`return { ok: false satisfies boolean };`)).toEqual([1]);
		expect(linesIn(`return { ok: (true as const)! };`)).toEqual([1]);
		// 整个字面量套在 satisfies / as 里,字面量本身照样是一处。
		expect(linesIn(`return { ok: true } satisfies Result;`)).toEqual([1]);
		expect(linesIn(`return { ok: false, code: "x" } as Failure;`)).toEqual([1]);
	});

	it('键的三种写法:ok、"ok"、["ok"]', () => {
		expect(linesIn(`return { "ok": false, err };`)).toEqual([1]);
		expect(linesIn(`return { ["ok"]: true };`)).toEqual([1]);
	});

	it("嵌在调用、三元、数组里也认得,一个字面量一处", () => {
		expect(linesIn(`return Response.json({ ok: false, err: "x" }, { status: 404 });`)).toEqual([1]);
		expect(linesIn(`send({ type: "result", id, ok: true });`)).toEqual([1]);
		expect(linesIn(`return bad ? { ok: false, errors } : { ok: true, value };`)).toEqual([1, 1]);
		expect(linesIn(`const all = [{ ok: true }, { ok: false }];`)).toEqual([1, 1]);
		// 外层的 view 不是结果,里面那个是:只算里面那一处。
		expect(linesIn(`return { view: { ok: true }, index };`)).toEqual([1]);
	});

	it("命中带行号(节点起点)与那一行的源码", () => {
		const hits = handWrittenResults(
			parseSource(
				"sample.ts",
				[`// 说明`, `export function check(x) {`, `\treturn {`, `\t\tok: false,`, `\t};`, `}`].join(
					"\n",
				),
			),
		);
		expect(hits).toEqual([{ line: 3, text: "{" }]);
	});
});

describe("手写结果的判据:不算", () => {
	it("类型里的 { ok: true }", () => {
		expect(
			linesIn(
				[
					`type R = { ok: true; id: string } | { ok: false; code: "invalid" };`,
					`interface Done { ok: true }`,
					`let r: { ok: boolean } = x;`,
					`function f(): { ok: false } { return fail("invalid", "x"); }`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("经 ok() / fail() 造的结果", () => {
		expect(linesIn(`return ok({ id });\nreturn fail("invalid", "形状不对");`)).toEqual([]);
	});

	it("值不是字面量布尔:转抄、简写、null、别的表达式", () => {
		expect(
			linesIn(
				[
					`return { ok: res.ok, latencyMs, err };`,
					`setToast({ msg, ok });`,
					`return { ok: null, latencyMs: 0 };`,
					`return { ok: !failed };`,
					`const s = z.object({ ok: z.literal(true) });`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("别的键、方法、解构、赋值、比较", () => {
		expect(
			linesIn(
				[
					`const a = { okay: true, isOk: false, OK: true };`,
					`const b = { ok() { return true; } };`,
					`const { ok } = result;`,
					`failure.ok = false;`,
					`if (result.ok === true) done();`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("注释、字符串、模板里的写法", () => {
		expect(
			linesIn(
				[
					`// 以前是 return { ok: true };`,
					`/** @example { ok: false, err } */`,
					`const a = "{ ok: true }";`,
					`const b = \`{ ok: false, code: \${code} }\`;`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

/** 范围:`apps/<应用>/src`、`packages/<包>/src`、`extensions/<拓展>/src`,仓库相对路径。 */
function scopeRoots() {
	const roots = [];
	for (const group of ["apps", "packages", "extensions"]) {
		for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(REPO_ROOT, group, entry.name, "src"))) {
				roots.push(`${group}/${entry.name}/src`);
			}
		}
	}
	return roots.sort();
}

/** 真去扫仓库:文件 → 命中。没有命中的文件不出现。 */
function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		const hits = handWrittenResults(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/** 一份源码导出的函数声明的名字。 */
function exportedFunctions(source) {
	return findNodes(
		source,
		(node) =>
			ts.isFunctionDeclaration(node) &&
			node.name !== undefined &&
			(node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
	).map((hit) => hit.node.name.text);
}

/**
 * 🔴 **真去扫仓里的代码。**
 *
 * 上面那些样例证明判据本身没写错;这一条证明**没有人真的在表外手写结果**。
 */
describe("仓里的结果都经 ok() / fail() 造", () => {
	it("范围认得对:服务端、面板、契约、核心包(含 ui)与拓展都在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/web/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/ui/src",
			"extensions/bridge/src",
		]) {
			expect(roots).toContain(expected);
		}
	});

	it("白名单里那个文件真的定义并导出了 ok() 与 fail()", () => {
		for (const file of Object.keys(ALLOWLIST)) {
			expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
			expect(exportedFunctions(parseSource(file)), file).toEqual(
				expect.arrayContaining(["ok", "fail"]),
			);
		}
	});

	it("表外没有手写的结果,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), { allowlist: ALLOWLIST, ratchet: RATCHET, what: "手写的结果" }),
		).toEqual([]);
	});
});
