import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import {
	findNodes,
	identifierSegments,
	listSources,
	parseSource,
	srcRootsUnder,
	ts,
} from "../source-scan.mjs";

/**
 * 推送守卫②:推送平台专有词(docs/1.0/architecture.md 第二层静态扫描「推送守卫②」那一行,ADR-0021 决策 60)。
 * 核心里写出某个推送平台的名字、连接方式、地址叫法、卡片形态,就是核心在适配器登记表外面又认了一遍那个平台。
 *
 * - 范围:`apps/server/src`、`apps/contract/src`、`packages/<包>/src`(`ui` 除外),不含测试。面板、桌面壳、拓展不扫。
 * - 整目录不扫:`platforms/`(内置适配器的实现,定案)、`migration/`(读 0.x 老数据,定案)、`bilibili/`(集成不是核心;
 *   定案那一行没写,补的一格,今天 0 处)。
 * - 白名单:`apps/server/src/compose.ts` 整文件 —— 组装根,整个核心只有它造并登记内置适配器(见 `ALLOWLIST` 里的理由)。
 * - 判据看语法树(注释天生不是节点,不再手写「先剥注释」)。节点:标识符(含 `#私有名`)、字符串字面量、模板的每一段文字、
 *   JSX 文字、正则字面量。一个节点一处(同一个节点命中两个词也只算一处,所以「按词」加起来会比处数多);报错点出是哪几个词。
 * - 词表分三组,各有各的匹配法:
 *   - **按段拼接**(`SEGMENT_WORDS`):名字切成段(驼峰的每一段与下划线、`$` 分开的每一段,一律小写;字符串先按「字母、数字、
 *     `_`、`$`、`-`」切成一串串,每一串再按 `-` 与标识符的规矩切段),**有几段连续的段拼起来正好等于词去掉 `-` 与 `_` 的紧凑写法**
 *     就算,不分大小写。为什么不是「有一段等于」:`miniAppCard` 切出来是 `mini` `app` `card`,没有哪一段叫 `miniapp`,
 *     只认单段会漏掉大半驼峰写法;为什么不是子串:`transportation`、`guildhall`、`openIdle`、`abc2c` 都含这几个字母。
 *     不跨空格拼(`"open id"` 是两串,不算)。
 *   - **`qq`,两种待遇**:标识符和长得像标识符的字符串(整个字符串能当标识符)里,**有一段是 `qq`** 就算(`QQOfficialBotType`、
 *     `qqBot`、`QQ_API`、图标名 `"qq"`;`QQ` 后面不跟大写字母的 `qq`、`qq_bot` 也算,宁可错杀);自由文本里原样用定案的
 *     `\bQQ[A-Z]`、**分大小写**(`"QQBot 在线"` 算;`"分享到 QQ"`、`"QQ 官方机器人"`、`"https://q.qq.com/x"` 不算 ——
 *     定案提醒过「分享到 QQ」这类说 B 站的语境别误伤)。两头合起来是定案的严格超集。分界是「字符串长不长得像标识符」:
 *     `"qq"` 算而 `"QQ 官方机器人"` 不算,看着像判据写错了,不是。别把它「修」成两边都算或两边都不算。
 *   - **CQ 码**:字符串、模板、正则字面量的文字里出现 `[CQ:`(正则里写成 `\[CQ:` 也算),分大小写。
 * - `user_id` / `group_id` 按段拼接,所以驼峰的 `userId` / `groupId` 也算(主人 10-12 定:认)。**同名不同物**:
 *   `packages/internal/src/post.ts` 里作品正文「@某人」片段的 `userId` 是来源那边的用户,不是推送平台的,语法上分不开,
 *   如实记在棘轮表里。`webhook` **不在词表**(主人 10-12 定:通用技术词;核心按适配器种类分叉那一类归推送守卫③)。
 * - `transport`、`openid` 是词表里最容易撞上别的意思的两个词(HTTP 传输、OpenID Connect),判据分不开。今天核心里 `transport`
 *   的命中全是 OneBot 连接的「怎么连」判别键、`openid` 全是 QQ 官方机器人的地址叫法;不预先排除,撞上的那天是主人看得见的一次点头。
 * - import 路径也是字符串,照算(`"./platforms/onebot.js"`)。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红。主人 10-12 定:清零期是 3b 末,
 *   清不了的几格(`packages/internal` 的平台表与连接设置规则等)照记,清零期的字面先不改,3b 收尾时再问。
 *
 * 抓不到的(靠审查与别的守卫):
 * - 中文叫法:`飞书`、`钉钉`、`企业微信`、`官机`、`小程序卡`(归第 4 期的中文叫法棘轮)。
 * - 自由文本里后面不跟大写字母的 `QQ` / `qq`:平台表的两个标签 `"QQ 官方机器人"`、`"QQ官方"`;`qq.com` 这类域名也在此列。
 * - `webhook` 一族:`config/store.ts` 里托管 webhook 目标那套「核心认识 webhook 这一种适配器」的逻辑(归推送守卫③)。
 * - 换了名字的同一个东西:把 `miniAppCard` 改叫 `shareCard`、把 `onebot` 存进变量再比(归 `.platform` 决定棘轮与推送守卫③)。
 * - 复数与变体:`transports`、`guilds`、`openids`;分开写的 `open id`、`user id`。
 * - 词表以外的平台名:`telegram`、`discord`、`lark`、`kook`……;加一个词表外的新平台这道看不见
 *   (「`CONNECTION_PLATFORMS` 不加档」仍靠审查与 `platform-registry.test.ts`)。
 * - 字符串拼出来的词(`"one" + "bot"`)。
 * - 面板、拓展、`packages/ui` 不在范围。
 * - `compose.ts` 里以后若长出登记以外的逻辑(`if (key === "onebot")`),这道看不见(整文件白名单的代价)。
 *
 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 整个目录放行(仓库相对、带结尾斜杠),写明理由。 */
export const ALLOWED_DIRS = {
	"apps/server/src/platforms/": "内置适配器的实现:平台专有词就该住在这里(定案)",
	"apps/server/src/migration/": "迁移模块:读 0.x 老数据,0.x 的形状只住这里(定案)",
	"apps/server/src/bilibili/": "集成不是核心(定案那一行没写,补的一格;今天没有命中)",
};

/** 白名单:整个文件放行,写明理由。 */
export const ALLOWLIST = {
	"apps/server/src/compose.ts":
		"组装根:整个核心只有它造并登记内置适配器(import 工厂、调用工厂、给每个适配器一个日志键),那几处就是登记本身,没有一处是登记以外的逻辑;出口由入口咽喉守卫钉着,里面长没长登记以外的逻辑仍靠审查",
};

/** 报错后面带的那句:越界怎么办。 */
export const ADVICE =
	"这是越界(核心里不许出现推送平台专有词):走中立的适配器描述与能力,或去问主人要不要加上限,不要起别的名字躲;数降了就当场把这一格调低";

/**
 * 按段拼接组:紧凑写法(去掉 `-` 与 `_`、小写)正好等于某几段连续的段。
 * `user_id` / `group_id` 连驼峰的 `userId` / `groupId` 一起认(主人 10-12 定)。
 */
export const SEGMENT_WORDS = [
	"onebot",
	"qq-official",
	"miniapp",
	"guild",
	"openid",
	"feishu",
	"dingtalk",
	"wecom",
	"napcat",
	"send_group_forward_msg",
	"ws-reverse",
	"transport",
	"get_mini_app_ark",
	"c2c",
	"user_id",
	"group_id",
];

/** `qq` 组的词(显示用):标识符与长得像标识符的字符串里有一段是它。 */
export const QQ_WORD = "qq";

/** `qq` 组在自由文本上的待遇:定案原文的 `\bQQ[A-Z]`,分大小写。 */
export const QQ_TEXT_PATTERN = /\bQQ[A-Z]/;

/** CQ 码:文字里出现 `[CQ:`(正则里写成 `\[CQ:` 也算),分大小写。 */
export const CQ_WORD = "[CQ:";
const CQ_PATTERN = /\\?\[CQ:/;

/** 词去掉 `-` 与 `_`、小写,拼成的紧凑写法。 */
const compactOf = (word) => word.replace(/[-_]/g, "").toLowerCase();

/** 整个字符串长得像标识符。 */
const LOOKS_LIKE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** 字符串里的一串串:字母、数字、`_`、`$`、`-`。 */
const TEXT_RUN = /[A-Za-z0-9_$-]+/g;

/** 段序列里有没有连续几段拼起来正好等于 `compact`。 */
function hasRun(segments, compact) {
	for (let start = 0; start < segments.length; start++) {
		let joined = "";
		for (let end = start; end < segments.length; end++) {
			joined += segments[end];
			if (joined === compact) return true;
			if (!compact.startsWith(joined)) break;
		}
	}
	return false;
}

/** 一串段命中的按段拼接词。 */
function segmentWordsOf(segments) {
	return SEGMENT_WORDS.filter((word) => hasRun(segments, compactOf(word)));
}

/** 一个名字(标识符)命中了词表里的哪些词,按词表顺序;没有给 `[]`。 */
export function wordsInIdentifier(name) {
	const segments = identifierSegments(name.replace(/^#/, ""));
	const words = segmentWordsOf(segments);
	if (segments.includes(QQ_WORD)) words.push(QQ_WORD);
	return words;
}

/** 一段文字(字符串、模板片段、JSX 文字、正则字面量)命中了哪些词。长得像标识符的转给 `wordsInIdentifier`。 */
export function wordsInText(text) {
	if (LOOKS_LIKE_IDENTIFIER.test(text)) return wordsInIdentifier(text);
	const words = new Set();
	for (const run of text.match(TEXT_RUN) ?? []) {
		const segments = run.split("-").flatMap((part) => identifierSegments(part));
		for (const word of segmentWordsOf(segments)) words.add(word);
	}
	const hits = SEGMENT_WORDS.filter((word) => words.has(word));
	if (QQ_TEXT_PATTERN.test(text)) hits.push(QQ_WORD);
	if (CQ_PATTERN.test(text)) hits.push(CQ_WORD);
	return hits;
}

/** 这个节点命中的词(没有给 `[]`):文字节点、正则字面量、标识符。 */
function wordsOfNode(node) {
	if (
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node) ||
		ts.isJsxText(node) ||
		ts.isRegularExpressionLiteral(node)
	) {
		return wordsInText(node.text);
	}
	if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return wordsInIdentifier(node.text);
	return [];
}

/**
 * 一份源码里的推送平台专有词:`{ line, text, words }[]`,按出现顺序,一个节点一处。
 * `text` 是那一段源码后面带上命中的词(`miniAppCard ← miniapp`),红的时候看得出为什么。
 */
export function platformVocabularyHits(source) {
	const found = new Map();
	return findNodes(source, (node) => {
		const words = wordsOfNode(node);
		if (words.length > 0) found.set(node, words);
		return words.length > 0;
	}).map(({ node, line, text }) => {
		const words = found.get(node);
		return { line, text: `${text} ← ${words.join(", ")}`, words };
	});
}

const sample = (text, file = "sample.ts") => platformVocabularyHits(parseSource(file, text));
const wordsIn = (text) => sample(text).flatMap((hit) => hit.words);

describe("推送守卫②的判据:算", () => {
	it("标识符:各种写法的平台名、连接方式、卡片形态", () => {
		for (const [name, word] of [
			["OnebotWsSettingsSchema", "onebot"],
			["ONEBOT_IMAGE_MIN_TIMEOUT_MS", "onebot"],
			["oneBotAdapter", "onebot"],
			["createQQOfficialAdapter", "qq-official"],
			["QQOfficialBotType", "qq-official"],
			["miniAppCard", "miniapp"],
			["miniAppCardLinks", "miniapp"],
			["useMiniApp", "miniapp"],
			["canSendMiniAppCard", "miniapp"],
			["guildId", "guild"],
			["groupOpenid", "openid"],
			["openId", "openid"],
			["napCatVersion", "napcat"],
			["transport", "transport"],
			["OnebotTransport", "transport"],
			["wsReverse", "ws-reverse"],
			["isC2c", "c2c"],
			["C2C_EVENT", "c2c"],
			["send_group_forward_msg", "send_group_forward_msg"],
			["get_mini_app_ark", "get_mini_app_ark"],
		]) {
			expect(wordsInIdentifier(name), name).toContain(word);
		}
	});

	it("标识符:不分大小写,名字在对象键、属性访问、接口成员的位置都算", () => {
		expect(wordsIn("const o = { onebot: {} };")).toEqual(["onebot"]);
		expect(wordsIn("x.feishu;")).toEqual(["feishu"]);
		expect(wordsIn("interface A { dingtalk: 1 }")).toEqual(["dingtalk"]);
		expect(wordsIn("const { wecom } = x;")).toEqual(["wecom"]);
		expect(wordsIn("class A { #onebot = 1 }")).toEqual(["onebot"]);
	});

	it("`user_id` / `group_id`:蛇形和驼峰都算(主人 10-12 定)", () => {
		for (const name of [
			"user_id",
			"group_id",
			"userId",
			"groupId",
			"resolveGroupIdOf",
			"USER_ID",
		]) {
			expect(wordsInIdentifier(name), name).not.toEqual([]);
		}
		expect(wordsIn("const o = { userId: 1, group_id: 2 };")).toEqual(["user_id", "group_id"]);
	});

	it("连续段拼接而不是「有一段等于」:`miniAppCard`、`oneBotAdapter`、`C2C` 都是几段拼起来的", () => {
		expect(identifierSegments("miniAppCard")).not.toContain("miniapp");
		expect(wordsInIdentifier("miniAppCard")).toEqual(["miniapp"]);
		expect(wordsInIdentifier("oneBotAdapter")).toEqual(["onebot"]);
		expect(identifierSegments("C2C")).toEqual(["c2", "c"]);
		expect(wordsInIdentifier("C2C")).toEqual(["c2c"]);
	});

	it("`qq` 在标识符里:有一段是 `qq` 就算,后面不跟大写字母的也算", () => {
		for (const name of ["qqBot", "QQ_API", "qq", "QQ", "qq_bot", "QQBot"]) {
			expect(wordsInIdentifier(name), name).toContain("qq");
		}
		expect(wordsInIdentifier("QQOfficialBotType")).toEqual(["qq-official", "qq"]);
	});

	it('`qq` 在长得像标识符的字符串里同样算:图标名 `"qq"`、`"QQ_API"`', () => {
		expect(wordsIn('const icon = "qq";')).toEqual(["qq"]);
		expect(wordsIn('const k = "QQ_API";')).toEqual(["qq"]);
	});

	it("`qq` 在自由文本里:`QQ` 后面跟大写字母才算,分大小写", () => {
		expect(wordsIn('const s = "QQBot 在线";')).toEqual(["qq"]);
		expect(wordsInText("QQBot 在线")).toEqual(["qq"]);
	});

	it("字符串:平台名、带空格的叫法、带 `-` 的复合词、带中文的叫法", () => {
		expect(wordsIn('const k = "onebot";')).toEqual(["onebot"]);
		expect(wordsIn('const k = "OneBot v11";')).toEqual(["onebot"]);
		expect(wordsIn('const k = "qq-official";')).toEqual(["qq-official"]);
		expect(wordsIn('const k = "miniapp-card";')).toEqual(["miniapp"]);
		expect(wordsIn('const k = "miniAppCard";')).toEqual(["miniapp"]);
		expect(wordsIn('const k = "ws-reverse";')).toEqual(["ws-reverse"]);
		expect(wordsIn('const k = "transport";')).toEqual(["transport"]);
		expect(wordsIn('const k = "群 openid";')).toEqual(["openid"]);
		expect(wordsIn('const k = "C2C";')).toEqual(["c2c"]);
		expect(wordsIn('const k = "user_id";')).toEqual(["user_id"]);
	});

	it("模板的每一段文字都看,头、中、尾各是一个节点", () => {
		expect(wordsIn("const s = `没有 " + "$" + "{x} 的 onebot 连接`;")).toEqual(["onebot"]);
		expect(wordsIn("const s = `onebot " + "$" + "{x} 和 " + "$" + "{y} feishu`;")).toEqual([
			"onebot",
			"feishu",
		]);
		expect(wordsIn("const s = `只有 onebot`;")).toEqual(["onebot"]);
	});

	it("import 路径也是字符串,照算", () => {
		expect(wordsIn('import { x } from "./platforms/onebot.js";')).toEqual(["onebot"]);
	});

	it("CQ 码:字符串与正则字面量(写成 `\\[CQ:` 也算),分大小写", () => {
		expect(wordsIn('const s = "[CQ:at,qq=1]";')).toEqual(["[CQ:"]);
		expect(wordsIn("const r = /\\[CQ:reply/;")).toEqual(["[CQ:"]);
		expect(wordsIn('const s = "[cq:at]";')).toEqual([]);
	});

	it("正则字面量也看", () => {
		expect(wordsIn("const r = /onebot-(\\d+)/;")).toEqual(["onebot"]);
	});

	it("JSX 文字也看", () => {
		expect(
			platformVocabularyHits(parseSource("sample.tsx", "const el = <a>去 onebot 看</a>;")).flatMap(
				(hit) => hit.words,
			),
		).toEqual(["onebot"]);
	});

	it("一个节点一处:一个名字、一个字符串里有两个词也只算一处", () => {
		const hits = sample("const OnebotWsReverseSettingsSchema = 1;");
		expect(hits).toHaveLength(1);
		expect(hits[0].words).toEqual(["onebot", "ws-reverse"]);
		expect(sample('const s = "onebot 与 feishu";')).toHaveLength(1);
	});

	it("一个模板里头尾两段都有词,算两处(有意的)", () => {
		expect(sample("const s = `onebot " + "$" + "{x} feishu`;")).toHaveLength(2);
	});

	it("命中带行号(从 1 起)、那一段源码与是哪个词", () => {
		expect(sample("\nconst k = x.miniAppCard;")).toEqual([
			{ line: 2, text: "miniAppCard ← miniapp", words: ["miniapp"] },
		]);
	});
});

describe("推送守卫②的判据:不算", () => {
	it("只是碰巧含这几个字母的名字", () => {
		for (const name of [
			"transportation",
			"transports",
			"guildhall",
			"openIdle",
			"welcome",
			"weComputed",
			"abc2c",
			"rpc2Client",
			"miniApplication",
			"phoneBot",
			"guilds",
			"openids",
		]) {
			expect(wordsInIdentifier(name), name).toEqual([]);
		}
	});

	it("`webhook` 不在词表(主人 10-12 定),`generic` 也不是", () => {
		for (const name of [
			"webhook",
			"WebhookConnectionSettingsSchema",
			"isWebhookPlatform",
			"generic",
		]) {
			expect(wordsInIdentifier(name), name).toEqual([]);
		}
		expect(wordsIn('const k = "webhook";')).toEqual([]);
	});

	it("`qq` 在自由文本里:后面不跟大写字母的 `QQ`、域名都不算", () => {
		expect(wordsIn('const s = "分享到 QQ";')).toEqual([]);
		expect(wordsIn('const s = "QQ 官方机器人";')).toEqual([]);
		expect(wordsIn('const s = "QQ官方";')).toEqual([]);
		expect(wordsIn('const s = "https://q.qq.com/x";')).toEqual([]);
		expect(wordsIn('const s = "https://qqmail.com/x";')).toEqual([]);
	});

	it("`ark` 单独不是词:火山方舟的地址不误伤", () => {
		expect(wordsIn('const u = "https://ark.cn-beijing.volces.com/api/v3";')).toEqual([]);
	});

	it("中间有空格是两串,不拼", () => {
		expect(wordsIn('const s = "open id";')).toEqual([]);
		expect(wordsIn('const s = "user id";')).toEqual([]);
	});

	it("中文叫法归第 4 期,不在这道", () => {
		for (const text of ["飞书机器人", "官机", "小程序卡", "钉钉", "企业微信"]) {
			expect(wordsIn(`const s = "${text}";`), text).toEqual([]);
		}
	});

	it("注释里的任何词", () => {
		expect(
			wordsIn(
				"// onebot 与 miniAppCard 与 QQBot 与 [CQ:at] 与 userId\n/* transport guild openid */ const a = 1;",
			),
		).toEqual([]);
	});
});

/** 范围:服务端、contract 与 `packages/<包>/src`(`ui` 除外),仓库相对路径。 */
function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], {
		except: ["apps/desktop/src", "apps/web/src", "packages/ui/src"],
	});
}

/** 真去扫仓库:文件 → 命中。整目录不扫的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (Object.keys(ALLOWED_DIRS).some((dir) => file.startsWith(dir))) continue;
		const hits = platformVocabularyHits(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 棘轮表:文件 → 命中的上限(开张时的现数)。只许往下调。
 * 行内注释只如实写这一格是什么,不写清零期。
 */
export const RATCHET = {
	"apps/server/src/devtools/capture.ts": 1, // 重推载荷种类 `"miniapp-card"`
	"apps/server/src/devtools/fake-bridge.ts": 4, // 假桥入站帧的 `userId` / `groupId`(私聊 1、群 2)与 `miniAppCardLinks`
	"apps/server/src/devtools/scenarios/bridge.ts": 12, // 假 bot 的平台默认值 `"onebot"`×2、能力表 `miniAppCard`×2、入站的 `userId` / `groupId`×8
	"apps/server/src/devtools/scenarios/capability.ts": 5, // 能力注入场景里的 `miniAppCard`
	"apps/server/src/devtools/scenarios/inbound.ts": 18, // 入站场景的参数名与变量 `userId` / `groupId`×15、提示文字里的「群 openid」「OneBot / 官机」、`miniAppCardLinks`
	"apps/server/src/history/repush-store.ts": 3, // 重推原件的载荷种类 `"miniapp-card"`
	"apps/server/src/history/store.ts": 1, // 同上
	"apps/server/src/runtime/command-dispatcher.ts": 1, // 私聊入站的 `msg.userId`
	"apps/server/src/runtime/engines.ts": 1, // `connectionCapabilities(…)?.miniAppCard`
	"apps/server/src/runtime/link-parser.ts": 25, // 小程序卡 13(`miniAppCardOf`、`useMiniApp`、`"miniapp-card"`……)、群入站的 `groupId` / `userId` 12
	"apps/server/src/runtime/link-reply.ts": 2, // 回复目的地的 `groupId`
	"apps/server/src/runtime/link-scope.ts": 5, // 链接作用域键的 `groupId`
	"packages/internal/src/constants.ts": 29, // 闭集与平台表 24(`CONNECTION_PLATFORMS`、`PLATFORM_REGISTRY`、`WEBHOOK_PLATFORMS`)、OneBot 超时下限 2、保留 id `"onebot"` / `"qq-official"` 2、链接回复形式 `"miniapp"` 1
	"packages/internal/src/platform.ts": 2, // 载荷种类 `"miniapp-card"` 与能力格 `miniAppCard`
	"packages/internal/src/post.ts": 1, // 同名不同物:作品正文「@某人」片段的 `userId`,是来源那边的用户,不是推送平台的入站地址
	"packages/internal/src/push-source.ts": 5, // 私聊 / 群入站形状的 `userId` / `groupId`×4、`miniAppCardLinks`
	"packages/internal/src/schema/targets.ts": 32, // OneBot 连接设置规则 25(`Onebot*Schema`、`ONEBOT_*_MIN_TIMEOUT_MS`、`transport`、`"ws-reverse"`)与 QQ 官方连接设置规则 7(`QQOfficial*`)
};

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这一条证明表外没有人又写回来。
 */
describe("核心里不再长出推送平台专有词", () => {
	it("范围认得对:服务端、contract 与核心包都在,面板、桌面壳、packages/ui、拓展不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/push/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots).not.toContain("apps/web/src");
		expect(roots).not.toContain("apps/desktop/src");
		expect(roots).not.toContain("packages/ui/src");
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
	});

	it("整目录不扫的目录与白名单的文件真的存在", () => {
		for (const dir of Object.keys(ALLOWED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
		for (const file of Object.keys(ALLOWLIST)) {
			expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
		}
	});

	it("白名单的文件里真的有命中(不留死条目)", () => {
		for (const file of Object.keys(ALLOWLIST)) {
			expect(
				platformVocabularyHits(parseSource(file)).length,
				`${file}: 白名单里有、文件里没有命中 —— 删掉这一条`,
			).toBeGreaterThan(0);
		}
	});

	it("表外没有推送平台专有词,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET,
				what: "推送平台专有词",
				advice: ADVICE,
			}),
		).toEqual([]);
	});
});
