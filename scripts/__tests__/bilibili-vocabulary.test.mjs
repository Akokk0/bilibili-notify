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
 * 守卫 11:B 站专有词(docs/1.0/architecture.md 第二层静态扫描「守卫 11」那一行,ADR-0021 决策 59)。
 * 核心里写出 B 站的原始字段名、类型常量、域名、风控码,就是核心在登记表外面又认了一遍 B 站。
 *
 * - 范围:`apps/server/src`、`apps/contract/src`、`packages/<包>/src`,不含测试。面板不扫(定案明写);桌面壳、拓展不算核心。
 * - 整目录不扫:`bilibili/`(B 站自己)、`migration/`(0.x 的形状)、`platforms/`(内置平台适配器是集成不是核心,
 *   它们也在抄外部协议的 snake_case 字段,如 QQ 的 `msg_type`)。白名单:空。
 * - 判据看语法树(不再用正则扫代码,注释天生不是节点)。词表分四组,各有各的匹配法:
 *   - 前缀(`DYNAMIC_TYPE_` 等):标识符以它开头;字符串里按词边界出现(左边不是字母、数字、下划线)。
 *   - 整名(`module_dynamic`、`live_status`、`room_id`……,再加自动词表):标识符**整个正好是**它;字符串里按词边界出现
 *     (两边都不是字母、数字、下划线)。**不按段**:按段会误中我们自己起的驼峰名(`jumpUrl`、`SubscriptionLiveStatus`、
 *     `LIVE_TIME_ZONE`、`guardLevel`)。snake_case 是 B 站原始字段的指纹,驼峰是我们自己的名字。这是和 B 站替身守卫
 *     (按段切)故意不同的地方。
 *   - 按段(`roomId`、`bvid`):标识符切段后含这串段(`resolveRoomIdFromUid`、`onRoomIdResolved`、`shortRoomId` 算,
 *     `roomIds`、`broomId` 不算);字符串里按词边界出现。
 *   - 文字(`bilibili.com`、`b23.tv`、`hdslb`):字符串、模板片段、JSX 文字里出现这串字就算。
 *   - 风控码(`-352`、`-412`、`-799`):带负号的数字字面量。`-403` 不收(与 HTTP 状态码同数)。
 *   - 一个节点一处(一个字符串里同时有两个词也只算一处);报错点出是哪个词。
 * - **自动词表**:取 `bilibili/`(非测试)里接口、类型字面量的属性签名与枚举成员中,名字全小写且带下划线的键
 *   (`GENERATED_KEYS`,排好序,快照在本文件里)。生成函数 `generatedKeysOf` 有自己的样例;另有一条断言钉住「现生成 = 快照」,
 *   不一致就红并点名多了哪几个、少了哪几个。这样 `bilibili/` 加了新的原始字段,红的是「快照该更新了」,不是核心里某个
 *   文件突然多一处;更新快照后核心里若真有同名字段,再由棘轮那一条红。`GENERATED_KEY_EXCLUSIONS`(键 → 理由)是生成出来但不算
 *   B 站专有的通用词,今天空,加一条要主人点头;排除表里的键必须还在生成结果里(不留死条目)。
 *   定案原写三样(导出名、方法名、类型的键),主人 10-12 定只取 snake_case 的类型键。
 *   **生成函数只认属性签名与枚举成员**:以后 B 站的回应若改用 zod 校验,要让它也认对象字面量的键。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红。主人 10-12 定:清零期是 3b 末,
 *   清不了的几格照记,清零期的字面先不改,3b 收尾时再问。
 *
 * 抓不到的(靠审查与别的守卫):
 * - 不带下划线的 B 站原始字段(`mid`、`uname`、`face`、`aid`、`cid`、`pubdate`、`opus`、`archive`、`pics`)没法自动认,
 *   要抓只能手补进词表,而 `face`、`archive`、`share`、`like` 是普通英文词。
 * - `bilibili/` 导出的名字在核心里被用(归「核心 import `bilibili/`」那道守卫与入口咽喉)。
 * - 中文叫法(归第 4 期的中文叫法棘轮)。
 * - 一个 B 站词都没有的语义后门(归对拍)。
 * - `uid`(另一道守卫)。
 * - 驼峰化的 B 站字段(`liveStatus`):故意放行,见上面「不按段」;核心自己起的驼峰名里若藏着 B 站语义,靠审查。
 * - 复数 `roomIds`、`bvids`:按段不认(今天没有这样的名字),要抓就在样例里加一条再定。
 * - 切段的边界(都验过不红,样例钉着):`bvId`、`BvId`、`bv_id`(切成 `bv` `id`,不是 `bvid`)。算的是 `roomID`、
 *   `ROOM_ID`、`bvid`、`BVID`;全小写的 `roomid` 是一整段(不是 `room` `id`),手补进了整名组。
 * - **自动词表有漏**:它只认 `bilibili/` 里写成类型声明(属性签名、枚举成员)的下划线字段。没写成类型声明、从没有类型的回应上
 *   直接读、或写在对象字面量里的原始字段不在词表里,核心用到它们时这道看不见:`module_stat`、`is_only_fans`、`head_text`、
 *   `desc_second`、`qrcode_key`、`refresh_csrf`、`grisk_id`、`jump_style`、`icon_badge`、`comment_id_str`、
 *   `pub_action_text`、`room_admin_entrance` 等(审查稿列了二十来个)。核心里今天真在用的 `live_room` / `roomid`
 *   (`routes/cards.ts`)已手补进 `WHOLE_WORDS`;别的靠审查,或再手补。`SESSDATA` / `bili_jct` 原先因日志脱敏的正则手补过,
 *   3b-38 改成按值遮、核心里不再有人用,已撤。
 *   **「现生成 = 快照」那条只证明两边一致,不证明没漏**:生成函数少认一种写法时快照跟着少,照样绿。
 *   生成函数不改(主人定:只手补核心里今天真在用的)。手补的词按整名认、**大小写敏感**:`live_room` 只认这一种写法,`Live_Room` 认不出。
 * - **正则里的词只认到「标点转义」为止**:正则字面量把 `\.` 等标点转义的反斜杠去掉(`bilibili\.com` → `bilibili.com`)、字母转义
 *   (`\b` `\d`)换成空格;字符串与模板里写的正则(`new RegExp("bilibili\\.com")`)只还原标点转义、不动字母转义
 *   (`new RegExp("\\bbvid=(\\w+)")` 里的 `\b` 没换成分隔,`bbvid` 不是词边界,认不出)。认不出的还有:
 *   - 分组与字符类拆开的词:`/bilibili\.(?:com|cn)/`、`/b23[.]tv/`、`/bilibili[.]com/`、`/bili(?:bili)?\.com/`;
 *   - 大小写不敏感的正则(`/BILIBILI\.COM/i`:词表按写出来的样子比)、十六进制转义(`/b23\x2etv/`);
 *   - 风控码只认数字字面量(`/code=-352/` 不认)、`BV` 号的正则(`/BV[0-9A-Za-z]{10}/`,词表里没有对应的词)。
 * - **通用词在正则与字符串里也会红**:`created_at`、`refresh_token` 这类自动词表里的通用词,写在正则或字符串里(`/created_at|updated_at/`、
 *   `/refresh_token=([^&]+)/`)一样算一处。出路是排除表 `GENERATED_KEY_EXCLUSIONS`,要问主人。
 *   `redact.ts` 那一格里的 `refresh_token`×3 就是这一种。
 * - 字符串拼出来的词(`"room" + "_id"`、`["bilibili", "com"].join("\\.")`)。
 *
 * 这两道守卫(守卫 11 与 `.platform` 决定)按写法的样子认,认不全;上面列的是已知的,不再为新试出的绕法逐个改判据,
 * 靠审查与期末的代码审查。
 *
 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** B 站自己的目录:自动词表从这里生成,核心的扫描也不进它。 */
const BILIBILI_DIR = "apps/server/src/bilibili/";

/** 整个目录放行(仓库相对、带结尾斜杠),写明理由。 */
export const ALLOWED_DIRS = {
	[BILIBILI_DIR]: "B 站自己的代码:它的原始字段就叫原始字段",
	"apps/server/src/migration/": "迁移模块:0.x 的形状只住这里",
	"apps/server/src/platforms/":
		"内置平台适配器:集成不是核心,它们也在抄外部协议的 snake_case 字段(如 QQ 的 msg_type)",
};

/** 白名单:整个文件放行,写明理由。今天没有。 */
export const ALLOWLIST = {};

/** 报错后面带的那句:越界怎么办。 */
export const ADVICE =
	"若是越界(核心里不许出现 B 站专有词):走中立的字段与来源登记表,不要起别的名字躲;若确是同名不同物(自动词表里的通用词如 `created_at`、`end_time`、`has_more`、`refresh_token`,AI 服务商的接口里也有)或这道守卫的判据打不准:去问主人,由主人定是进排除表 `GENERATED_KEY_EXCLUSIONS`、加上限还是改判据,不要自己加;数降了就当场把这一格调低";

/** 前缀组:标识符以它开头;字符串里按词边界出现。 */
export const PREFIX_WORDS = ["DYNAMIC_TYPE_", "RICH_TEXT_NODE_", "MAJOR_TYPE_", "ADDITIONAL_TYPE_"];

/** 整名组(手写的那部分):标识符整个正好是它;字符串里按词边界出现。 */
export const WHOLE_WORDS = [
	"module_dynamic",
	"jump_url",
	"id_str",
	"guard_level",
	"live_time",
	"live_status",
	"room_id",
	"WATCHED_CHANGE",
	"bili_user",
	// 核心自己声明并读 B 站用户资料回应里的 `live_room.roomid`(`routes/cards.ts`)。自动词表只认类型声明里的下划线字段,
	// 而这两个是核心里手写类型直接读的;`roomid` 不带下划线(自动词表认不出)、全小写是一整段(不与按段组的 `roomId` 归一)。
	"live_room",
	"roomid",
];

/** 按段组:标识符切段后含这串段;字符串里按词边界出现。 */
export const SEGMENT_WORDS = ["roomId", "bvid"];

/** 文字组:字符串、模板片段、JSX 文字里出现这串字就算。 */
export const TEXT_WORDS = ["bilibili.com", "b23.tv", "hdslb"];

/** 风控码:带负号的数字字面量。`-403` 不收(与 HTTP 状态码同数)。 */
export const RISK_CODES = new Set(["-352", "-412", "-799"]);

/**
 * 自动词表快照:`bilibili/`(非测试)里属性签名与枚举成员中全小写带下划线的键,排好序。
 * 与 `generatedKeys()` 的现生成结果必须一致(「快照与现生成一致」那一条钉着)。
 */
export const GENERATED_KEYS = [
	"anchor_roomid",
	"area_id",
	"area_name",
	"award_name",
	"award_num",
	"award_type",
	"award_users",
	"b_3",
	"batch_combo_id",
	"click_count",
	"coin_type",
	"combo_total_coin",
	"copy_writing",
	"created_at",
	"current_level",
	"emoticon_unique",
	"end_time",
	"fans_medal",
	"fold_action",
	"follower_num",
	"gift_id",
	"gift_list",
	"gift_name",
	"guard_info",
	"guard_level",
	"has_more",
	"host_list",
	"icon_name",
	"icon_url",
	"id_str",
	"img_label_uri_hans_static",
	"is_lighted",
	"jump_url",
	"l_img",
	"last_time",
	"level_info",
	"like_num",
	"live_room",
	"live_status",
	"live_time",
	"live_url",
	"lot_id",
	"master_level",
	"max_time",
	"medal_info",
	"medal_level",
	"medal_name",
	"module_author",
	"module_dynamic",
	"msg_type",
	"op_type",
	"orig_text",
	"parent_area_id",
	"parent_area_name",
	"pay_info",
	"privilege_type",
	"pub_action",
	"pub_time",
	"pub_ts",
	"qrcode_key",
	"refresh_token",
	"require_text",
	"rich_text_nodes",
	"role_name",
	"room_id",
	"s_img",
	"sender_name",
	"sender_uid",
	"sender_uinfo",
	"short_id",
	"start_time",
	"super_batch_gift_num",
	"target_id",
	"toast_msg",
	"total_num",
	"total_price",
	"update_baseline",
	"update_num",
	"user_cover",
	"user_info",
	"winner_info",
	"wss_port",
];

/** 生成出来但不算 B 站专有的通用词:键 → 理由。今天空;加一条要主人点头。 */
export const GENERATED_KEY_EXCLUSIONS = {};

/**
 * 棘轮表:文件 → 命中的上限(开张时的现数:13 个文件 62 处;认正则字面量、手补 `live_room` / `roomid` 之后:14 个文件 73 处)。只许往下调。
 * 行内注释只如实写这一格是什么,不写清零期。
 */
export const RATCHET = {
	"apps/server/src/compose.ts": 5, // R7 过渡口，3b-25 房号搬进 B 站 `ctx.state` 时随口删
	"apps/server/src/devtools/scenarios/bridge.ts": 1, // 假消息里的 `bilibili.com` 链接
	"apps/server/src/devtools/scenarios/inbound.ts": 1, // 同上
	"apps/server/src/routes/cards.ts": 20, // `roomId`×10、`live_status`、`room_id`、`short_id`、`module_author`,再加手补的 `live_room`×2、`roomid`×4(`live_room.roomid` 的读取)
	"apps/server/src/routes/subscriptions.ts": 1, // 文字里的 `bili_user`
	"apps/server/src/runtime/fans-poller.ts": 3, // 风控码 `-352`、`-412`、`-799`
	"apps/server/src/runtime/sub-runtime-store.ts": 1, // 订阅运行时里存的 B 站直播间号 `roomId`
	"packages/internal/src/bilibili-guard.ts": 1, // 文字里的 `hdslb`
};

/** 全小写、带下划线的键:`live_status`、`room_id`;驼峰、带大写、不带下划线的不算。 */
const SNAKE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** 属性名 / 成员名节点的文字(标识符或字符串字面量);别的写法(计算键、数字键)给 undefined。 */
function nameText(name) {
	return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** 一份源码里生成出来的键:接口与类型字面量的属性签名、枚举成员中,全小写带下划线的名字。 */
export function generatedKeysOf(source) {
	const keys = new Set();
	findNodes(source, (node) => {
		if (ts.isPropertySignature(node) || ts.isEnumMember(node)) {
			const text = nameText(node.name);
			if (text !== undefined && SNAKE_KEY.test(text)) keys.add(text);
		}
		return false;
	});
	return keys;
}

/** 现生成的自动词表:`bilibili/`(非测试)全部文件,排好序。 */
export function generatedKeys() {
	const keys = new Set();
	for (const file of listSources([BILIBILI_DIR.replace(/\/$/, "")])) {
		for (const key of generatedKeysOf(parseSource(file))) keys.add(key);
	}
	return [...keys].sort();
}

/** 现用的整名词:手写的加自动的,扣掉排除表。 */
export function wholeWords(generated = GENERATED_KEYS, exclusions = GENERATED_KEY_EXCLUSIONS) {
	const words = new Set(WHOLE_WORDS);
	for (const key of generated) if (!(key in exclusions)) words.add(key);
	return words;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_WORD = "A-Za-z0-9_";
/** 词边界:两边都不是字母、数字、下划线。 */
const boundaryOf = (word) => new RegExp(`(?<![${NOT_WORD}])${escapeRegExp(word)}(?![${NOT_WORD}])`);
/** 左边界:左边不是字母、数字、下划线;右边不限(前缀)。 */
const leftBoundaryOf = (word) => new RegExp(`(?<![${NOT_WORD}])${escapeRegExp(word)}`);

/** 标识符切段后,段序列里有没有连续含 `word` 切出来的那几段。 */
function hasSegments(segments, word) {
	const wanted = identifierSegments(word);
	for (let i = 0; i + wanted.length <= segments.length; i++) {
		if (wanted.every((segment, j) => segments[i + j] === segment)) return true;
	}
	return false;
}

/** 一个标识符命中的词(没有给 undefined)。 */
export function identifierWord(name, whole = wholeWords()) {
	for (const prefix of PREFIX_WORDS) if (name.startsWith(prefix)) return prefix;
	if (whole.has(name)) return name;
	const segments = identifierSegments(name);
	for (const word of SEGMENT_WORDS) if (hasSegments(segments, word)) return word;
	return undefined;
}

/** 一段文字(字符串、模板片段、JSX 文字)命中的词(没有给 undefined)。 */
export function textWord(text, whole = wholeWords()) {
	for (const prefix of PREFIX_WORDS) if (leftBoundaryOf(prefix).test(text)) return prefix;
	for (const word of whole) if (boundaryOf(word).test(text)) return word;
	for (const word of SEGMENT_WORDS) if (boundaryOf(word).test(text)) return word;
	for (const word of TEXT_WORDS) if (text.includes(word)) return word;
	return undefined;
}

/**
 * 正则字面量的源文还原成「人读的文字」再交给文字规则:`\.` `\/` 等标点转义去掉反斜杠(`bilibili\.com` → `bilibili.com`);
 * `\b` `\d` `\w` 这类字母转义换成一个空格(当分隔符,别让 `\bbvid` 变成 `bbvid` 而丢了词边界)。
 * 选这一种而不是给文字组的词各配一个带转义的写法:词表只有一份,不会两份写法漂开。
 */
export function regexSourceText(source) {
	return unescapePunctuation(source.replace(/\\([A-Za-z0-9])/g, " "));
}

/**
 * 去掉「反斜杠加标点」的反斜杠(`bilibili\.com` → `bilibili.com`),只这一种。字符串与模板里写的正则(`new RegExp("bilibili\\.com")`)
 * 取到的文字就是这个样子;字母转义(`\b` `\d`)不动 —— 普通字符串里的反斜杠加字母不一定是正则。
 */
export function unescapePunctuation(text) {
	return text.replace(/\\([^A-Za-z0-9\s])/g, "$1");
}

/** 文字节点(字符串、模板片段、JSX 文字)命中的词:先按原文比,没中再按还原了标点转义的文字比。 */
function textNodeWord(text, whole) {
	const direct = textWord(text, whole);
	if (direct !== undefined || !text.includes("\\")) return direct;
	return textWord(unescapePunctuation(text), whole);
}

/** 这个节点命中的词:文字节点、正则字面量、标识符、带负号的风控码。 */
function wordOfNode(node, whole) {
	if (
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node) ||
		ts.isJsxText(node)
	) {
		return textNodeWord(node.text, whole);
	}
	if (ts.isRegularExpressionLiteral(node)) return textWord(regexSourceText(node.text), whole);
	if (ts.isIdentifier(node)) return identifierWord(node.text, whole);
	if (
		ts.isPrefixUnaryExpression(node) &&
		node.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(node.operand)
	) {
		const code = `-${node.operand.text}`;
		return RISK_CODES.has(code) ? code : undefined;
	}
	return undefined;
}

/** 一份源码里的 B 站专有词:`{ line, text, word }[]`,按出现顺序。 */
export function vocabularyHits(source, whole = wholeWords()) {
	const words = new Map();
	return findNodes(source, (node) => {
		const word = wordOfNode(node, whole);
		if (word !== undefined) words.set(node, word);
		return word !== undefined;
	}).map(({ node, line, text }) => ({ line, text, word: words.get(node) }));
}

const sample = (text, whole) => vocabularyHits(parseSource("sample.ts", text), whole);
const wordsIn = (text, whole) => sample(text, whole).map((hit) => hit.word);

describe("守卫 11 的判据:算", () => {
	it("前缀组:标识符以它开头,字符串里按词边界出现", () => {
		expect(wordsIn("const t = DYNAMIC_TYPE_AV;")).toEqual(["DYNAMIC_TYPE_"]);
		expect(wordsIn('const t = "DYNAMIC_TYPE_AV";')).toEqual(["DYNAMIC_TYPE_"]);
		expect(wordsIn('const s = "类型 RICH_TEXT_NODE_TYPE_TEXT 的节点";')).toEqual([
			"RICH_TEXT_NODE_",
		]);
		expect(wordsIn("const a = MAJOR_TYPE_DRAW; const b = ADDITIONAL_TYPE_VOTE;")).toEqual([
			"MAJOR_TYPE_",
			"ADDITIONAL_TYPE_",
		]);
	});

	it("整名组:标识符整个正好是它,属性、解构、对象键、字符串键都算", () => {
		expect(wordsIn("d.module_dynamic;")).toEqual(["module_dynamic"]);
		expect(wordsIn("const o = { live_status: 1 };")).toEqual(["live_status"]);
		expect(wordsIn("const { room_id } = x;")).toEqual(["room_id"]);
		expect(wordsIn('const o = { "jump_url": 1 };')).toEqual(["jump_url"]);
		expect(wordsIn("const w = WATCHED_CHANGE;")).toEqual(["WATCHED_CHANGE"]);
		expect(wordsIn('const k = "bili_user";')).toEqual(["bili_user"]);
		expect(wordsIn("const id_str = 1; const guard_level = 2; const live_time = 3;")).toEqual([
			"id_str",
			"guard_level",
			"live_time",
		]);
	});

	it("整名组的字符串:两边是空白、标点、引号都算", () => {
		expect(wordsIn('const s = "读 live_status 字段";')).toEqual(["live_status"]);
		expect(wordsIn('const s = "(room_id)";')).toEqual(["room_id"]);
	});

	it("整名组包括自动词表里的词(传进去的)", () => {
		const whole = wholeWords(["module_author", "pub_ts"], {});
		expect(wordsIn("x.module_author;", whole)).toEqual(["module_author"]);
		expect(wordsIn("const o = { pub_ts: 1 };", whole)).toEqual(["pub_ts"]);
	});

	it("按段组:整名、前缀、中缀都算", () => {
		for (const name of [
			"roomId",
			"shortRoomId",
			"resolveRoomIdFromUid",
			"onRoomIdResolved",
			"bvid",
			"BVID",
			"bvidOf",
		]) {
			expect(identifierWord(name), name).toBeDefined();
		}
		expect(wordsIn('const s = "按 bvid 查";')).toEqual(["bvid"]);
		expect(wordsIn('const s = "roomId 缺失";')).toEqual(["roomId"]);
	});

	it("文字组:域名出现在字符串、带插值的模板、JSX 文字里", () => {
		expect(wordsIn('const u = "https://www.bilibili.com/video/";')).toEqual(["bilibili.com"]);
		expect(wordsIn("const u = `https://b23.tv/" + "$" + "{id}`;")).toEqual(["b23.tv"]);
		expect(wordsIn("const u = `x" + "$" + "{a}https://i0.hdslb.com/y`;")).toEqual(["hdslb"]);
		expect(
			vocabularyHits(parseSource("sample.tsx", "const el = <a>去 bilibili.com 看</a>;")).map(
				(hit) => hit.word,
			),
		).toEqual(["bilibili.com"]);
	});

	it("正则字面量:转义还原后再按文字规则比(域名、短链、`bvid=`)", () => {
		expect(wordsIn("const re = /bilibili\\.com\\/video\\/(BV\\w+)/;")).toEqual(["bilibili.com"]);
		expect(wordsIn("const re = /b23\\.tv\\/(\\w+)/;")).toEqual(["b23.tv"]);
		expect(wordsIn("const re = /\\bbvid=(\\w+)/;")).toEqual(["bvid"]);
		expect(regexSourceText("/b23\\.tv\\/\\bx/")).toBe("/b23.tv/ x/");
	});

	it("字符串与模板里写的正则:标点转义还原后再按文字规则比", () => {
		expect(wordsIn('const re = new RegExp("bilibili\\\\.com");')).toEqual(["bilibili.com"]);
		expect(wordsIn('const re = new RegExp("b23\\\\.tv/(\\\\w+)");')).toEqual(["b23.tv"]);
		expect(wordsIn("const re = new RegExp(`$" + "{H}\\\\.bilibili\\\\.com/video`);")).toEqual([
			"bilibili.com",
		]);
		// 普通字符串里的 `\n` 照旧不弄坏匹配
		expect(wordsIn('const s = "读 live_status\\n";')).toEqual(["live_status"]);
		expect(unescapePunctuation("a\\.b\\/c\\bd")).toBe("a.b/c\\bd");
	});

	it("手补进整名组的词:整名、大小写敏感,正则与字符串里也认", () => {
		expect(wordsIn("const k = live_room; const j = roomid;")).toEqual(["live_room", "roomid"]);
		expect(wordsIn("const re = /\\b(live_room)=[^;]+/gi;")).toEqual(["live_room"]);
		expect(wordsIn('const s = "roomid=abc";')).toEqual(["roomid"]);
		// 大小写敏感(钉住现状):换了大小写的认不出
		expect(wordsIn("const k = Live_Room;")).toEqual([]);
	});

	it("手补进整名组的 `live_room` / `roomid`:标识符、属性、类型成员、字符串", () => {
		expect(wordsIn("const roomid = info?.data?.live_room?.roomid;")).toEqual([
			"roomid",
			"live_room",
			"roomid",
		]);
		expect(wordsIn("interface A { live_room?: { roomid?: number } }")).toEqual([
			"live_room",
			"roomid",
		]);
	});

	it("风控码:带负号的数字字面量", () => {
		expect(wordsIn("if (code === -352) {}")).toEqual(["-352"]);
		expect(wordsIn("switch (c) { case -412: case -799: break; }")).toEqual(["-412", "-799"]);
	});

	it("一个节点一处:一个字符串里有两个词也只算一处", () => {
		expect(sample('const s = "live_status 与 room_id";')).toHaveLength(1);
	});

	it("命中带行号、那一段源码与是哪个词", () => {
		expect(sample("\nconst k = x.live_status;")).toEqual([
			{ line: 2, text: "live_status", word: "live_status" },
		]);
	});
});

describe("守卫 11 的判据:不算", () => {
	it("整名组不按段:驼峰孪生兄弟与带前后缀的名字放行", () => {
		for (const name of [
			"jumpUrl",
			"SubscriptionLiveStatus",
			"reportLiveStatus",
			"liveStatus",
			"LIVE_TIME_ZONE",
			"liveTimeText",
			"guardLevel",
			"TIER_KEY_OF_GUARD_LEVEL",
			"get_live_status",
			"live_status_text",
		]) {
			expect(identifierWord(name), name).toBeUndefined();
		}
		expect(wordsIn('const s = "get_live_status";')).toEqual([]);
		expect(wordsIn('const s = "live_status_text";')).toEqual([]);
	});

	it("按段组:段对不上的放行(复数、碰巧含这几个字母的)", () => {
		for (const name of ["roomIds", "broomId", "room", "id", "bvids", "abvid"]) {
			expect(identifierWord(name), name).toBeUndefined();
		}
		expect(wordsIn('const s = "broomId";')).toEqual([]);
	});

	it("按段组的切段边界(钉住现状,写进文件头的「抓不到」):`bvId` / `bv_id` 切成 `bv` `id`", () => {
		for (const name of ["bvId", "BvId", "bv_id"]) {
			expect(identifierWord(name), name).toBeUndefined();
		}
		// 同一类写法里算的(`roomid` 是手补进整名组的,见 `WHOLE_WORDS`)
		for (const name of ["roomID", "ROOM_ID", "bvid", "BVID", "roomid", "live_room"]) {
			expect(identifierWord(name), name).toBeDefined();
		}
	});

	it("前缀组:不是前缀的放行", () => {
		expect(identifierWord("MY_DYNAMIC_TYPE_X")).toBeUndefined();
		expect(wordsIn('const s = "MY_DYNAMIC_TYPE_X";')).toEqual([]);
	});

	it("风控码要带负号;-403 不收", () => {
		expect(wordsIn("const a = 352; const b = 412; const c = 799;")).toEqual([]);
		expect(wordsIn("const a = -403; const b = +352; const c = 1 - 352;")).toEqual([]);
	});

	it("包名、不带点的 bilibili、B 站替身的字面量归别的守卫", () => {
		expect(wordsIn('import { x } from "@bilibili-notify/internal";')).toEqual([]);
		expect(wordsIn('const k = "bilibili";')).toEqual([]);
		expect(wordsIn('const k = "@bilibili";')).toEqual([]);
	});

	it("正则字面量:不含任何词的普通正则、只是碰巧含这几个字母的放行", () => {
		expect(wordsIn("const re = /^\\d{4}-\\d{2}-\\d{2}$/;")).toEqual([]);
		expect(wordsIn("const re = /https?:\\/\\/example\\.com\\/(\\w+)/;")).toEqual([]);
		// 碰巧含:`notbvidx` 的 `bvid` 左右都贴着字母,不是词边界;`bilibilixcom` 没有点
		expect(wordsIn("const re = /notbvidx/;")).toEqual([]);
		expect(wordsIn("const re = /bilibili\\Dcom/;")).toEqual([]);
	});

	it("正则里认不出的(钉住现状,写进文件头的「抓不到」)", () => {
		for (const re of [
			"/bilibili\\.(?:com|cn)/",
			"/b23[.]tv/",
			"/BILIBILI\\.COM/i",
			"/b23\\x2etv/",
			"/code=-352/",
		]) {
			expect(wordsIn(`const re = ${re};`), re).toEqual([]);
		}
		// 字符串里的字母转义不还原:`\b` 没换成分隔,`bbvid` 不是词边界
		expect(wordsIn('const re = new RegExp("\\\\bbvid=(\\\\w+)");')).toEqual([]);
	});

	it("通用词出现在正则与字符串里也算(会误伤,出路是排除表,要问主人)", () => {
		expect(wordsIn("const re = /created_at|updated_at/;")).toEqual(["created_at"]);
		expect(
			wordsIn("const re = /refresh_token=([^&]+)/;", wholeWords(["refresh_token"], {})),
		).toEqual(["refresh_token"]);
	});

	it("字符串与模板里写的正则:带 `\\.` 却不含任何词的放行(真代码里的写法)", () => {
		expect(
			wordsIn("const T = new RegExp(`$" + "{escapeRegExp(TEMP_MARKER)}\\\\d+\\\\.[0-9a-f]+$`);"),
		).toEqual([]);
		expect(
			wordsIn("const D = new RegExp(`^(\\\\d+(?:\\\\.\\\\d+)?)\\\\s*($" + "{units.join('|')})$`);"),
		).toEqual([]);
	});

	it("注释", () => {
		expect(
			wordsIn(
				"// live_status 与 DYNAMIC_TYPE_AV 与 -352 与 bilibili.com\n/* roomId */ const a = 1;",
			),
		).toEqual([]);
	});
});

describe("自动词表的生成函数:各种声明写法", () => {
	const keys = (text) => [...generatedKeysOf(parseSource("sample.ts", text))].sort();

	it("接口的属性签名、类型别名里的类型字面量(含嵌套)、枚举成员", () => {
		expect(keys("interface A { live_status: number; room_id?: number }")).toEqual([
			"live_status",
			"room_id",
		]);
		expect(keys("type B = { jump_url: string; nested: { pub_ts: number } };")).toEqual([
			"jump_url",
			"pub_ts",
		]);
		expect(keys("enum E { room_id = 1, user_info = 2 }")).toEqual(["room_id", "user_info"]);
	});

	it("字符串键的属性签名与字符串名的枚举成员", () => {
		expect(keys('interface A { "live_status": number }')).toEqual(["live_status"]);
		expect(keys('enum E { "room_id" = 1 }')).toEqual(["room_id"]);
	});

	it("泛型位置与函数参数里的类型字面量也认", () => {
		expect(
			keys("function f(a: { module_author: string }): Array<{ level_info: number }> {}"),
		).toEqual(["level_info", "module_author"]);
	});

	it("不生成:驼峰、带大写、不带下划线、全大写、连续或首尾下划线", () => {
		expect(
			keys(
				"interface A { roomId: number; Live_status: number; uid: number; LIVE_STATUS: number; a__b: number; _a: number; a_: number }",
			),
		).toEqual([]);
	});

	it("不生成:对象字面量的键、方法签名、变量名、字符串内容、类的属性", () => {
		expect(
			keys(
				'const o = { live_status: 1 }; const room_id = 1; interface A { live_status(): void } const s = "jump_url"; class C { pub_ts = 1 }',
			),
		).toEqual([]);
	});

	it("注释里的不算", () => {
		expect(keys("// interface A { live_status: number }\ninterface B { x: number }")).toEqual([]);
	});
});

/** 范围:服务端、contract 与 `packages/<包>/src`,仓库相对路径。 */
function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], { except: ["apps/desktop/src", "apps/web/src"] });
}

/** 真去扫仓库:文件 → 命中(报错里点名是哪个词)。整目录不扫的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (Object.keys(ALLOWED_DIRS).some((dir) => file.startsWith(dir))) continue;
		const hits = vocabularyHits(parseSource(file));
		if (hits.length > 0) {
			found[file] = hits.map((hit) => ({ line: hit.line, text: `「${hit.word}」${hit.text}` }));
		}
	}
	return found;
}

describe("自动词表:快照与现生成一致", () => {
	it("快照排好序、没有重复", () => {
		expect(GENERATED_KEYS).toEqual([...new Set(GENERATED_KEYS)].sort());
	});

	it("现生成 = 快照:`bilibili/` 加了或删了原始字段,这一条红并点名", () => {
		const now = generatedKeys();
		const snapshot = new Set(GENERATED_KEYS);
		const generated = new Set(now);
		expect(
			{
				多了: now.filter((key) => !snapshot.has(key)),
				少了: GENERATED_KEYS.filter((key) => !generated.has(key)),
			},
			"`bilibili/` 的原始字段变了,把 GENERATED_KEYS 更新成现生成的;更新后核心里若真有同名字段,由下面的棘轮那一条红",
		).toEqual({ 多了: [], 少了: [] });
	});

	it("排除表里的键都还在生成结果里(不留死条目)", () => {
		const generated = new Set(generatedKeys());
		for (const key of Object.keys(GENERATED_KEY_EXCLUSIONS)) {
			expect(generated.has(key), `${key}: 排除表里有、生成结果里没有 —— 删掉这一条`).toBe(true);
		}
	});

	it("排除表的键从整名词里扣掉", () => {
		expect(wholeWords(["a_b", "c_d"], { c_d: "通用词" }).has("a_b")).toBe(true);
		expect(wholeWords(["a_b", "c_d"], { c_d: "通用词" }).has("c_d")).toBe(false);
	});
});

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这一条证明表外没有人又写回来。
 */
describe("核心里不再长出 B 站专有词", () => {
	it("范围认得对:服务端、contract 与核心包都在,面板、桌面壳、拓展不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/ai/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots).not.toContain("apps/web/src");
		expect(roots).not.toContain("apps/desktop/src");
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
	});

	it("整目录不扫的目录真的存在", () => {
		for (const dir of Object.keys(ALLOWED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
	});

	it("表外没有 B 站专有词,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET,
				what: "B 站专有词",
				advice: ADVICE,
			}),
		).toEqual([]);
	});
});
