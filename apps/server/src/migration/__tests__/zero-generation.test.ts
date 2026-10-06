/**
 * 第 0 代 → 新的一代(ADR-0022 决策 4、7)。
 *
 * 摆一棵 0.x 的夹具树,迁完看新代:每条 0.x 路径都到了代布局里该去的地方;文件一律复制
 * (没有一个和第 0 代共用),软链重建同样的一条;老形状的几族改写成最新的形状(各族的细节在各自的
 * `zero-generation-*.test.ts`);残留、卡片皮肤、宿主的东西不带过来;第 0 代一个字节都没动。
 *
 * 最后一条是修订号的闸:迁移的产出(搬了什么、搬到哪、怎么搬、丢下了什么)变了,就必须抬
 * `MIGRATION_REVISION` —— 否则开发期迁出来的那一代不会重迁,新代码读着旧产出。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import {
	MIGRATION_REVISION,
	type MigrationProgress,
	migrateZeroGeneration,
	zeroGenerationExists,
} from "../zero-generation.js";

let root: string;
let zero: string;
let target: string;

/** 迁移里那次历史清扫按这一刻算:夹具的历史都在 2026-09-30,保留 30 天,没有哪一天到期。 */
const NOW = new Date("2026-10-01T00:00:00.000Z");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-zero-generation-"));
	zero = join(root, "data");
	target = join(root, "data", "generations", "1.partial");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 0.x 的聊天附件(32 位 hex + 后缀):一张真图、一个被会话引用却不是图的、一张没人引用的(孤儿)。 */
const CHAT_ATTACHMENT = `${"a1".repeat(16)}.png`;
const CHAT_NOT_AN_IMAGE = `${"b2".repeat(16)}.png`;
const CHAT_ORPHAN = `${"c3".repeat(16)}.png`;
/** 聊天附件进图库以后的引用:字节的 sha256 + 嗅探出来的扩展名。 */
const CHAT_REF = `${createHash("sha256").update(PNG_BYTES).digest("hex")}.png`;

/**
 * 0.x 的拓展订阅头像:资料缓存里 `sub-2` 引用着 `avatars/sub-2.jpeg`(一张真图,与聊天附件那张不同内容 ——
 * 同字节同引用,两条 transfers 会指到一处,看着像 bug);`avatars/sub-9.webp` 没有任何资料引用(孤儿)。
 */
const AVATAR_REF = `${createHash("sha256").update(JPEG_BYTES).digest("hex")}.jpg`;
/** 0.x 的 B 站订阅资料里头像是远端网址。 */
const BILI_AVATAR_URL = "https://i0.hdslb.com/bfs/face/abc.jpg";

/**
 * 0.x 的历史图:`history/img/a.png` 被夹具里那一行引用着(保留期内),所以复制进图库、行里换成引用。内容与聊天附件
 * 那张不同(同字节同引用,两条 transfers 会指到一处,看着像 bug)。
 */
const HISTORY_IMAGE_BYTES = Buffer.concat([PNG_BYTES, Buffer.from([7])]);
const HISTORY_REF = `${createHash("sha256").update(HISTORY_IMAGE_BYTES).digest("hex")}.png`;

/** 0.x 夹具里的二进制件:相对第 0 代根的路径 → 字节。 */
const ZERO_BINARY_FILES: Record<string, Uint8Array> = {
	"history/img/a.png": HISTORY_IMAGE_BYTES,
	[`assets/chat/${CHAT_ATTACHMENT}`]: PNG_BYTES,
	[`assets/chat/${CHAT_NOT_AN_IMAGE}`]: Buffer.from("<svg/>"),
	[`assets/chat/${CHAT_ORPHAN}`]: Buffer.concat([PNG_BYTES, Buffer.from([1])]),
	"avatars/sub-2.jpeg": JPEG_BYTES,
	"avatars/sub-9.webp": WEBP_BYTES,
};

/** 0.x 夹具:相对第 0 代根的路径 → 内容。 */
const ZERO_FILES: Record<string, string> = {
	// 老形状的设置与订阅(第二代附加项、第一代 routing + @全体):第二遍会改写它们。
	"state/globals.json": JSON.stringify({
		// B 站的两格搬进它自己的设置文件(ADR-0021 决策 42 下 10-01 的 🔗);自定义 UA 丢掉(ADR-0025 决策 7),
		// 摘要里它哪儿都不在 —— 谁把它又搬进 settings/bilibili.json,摘要就变。
		app: {
			logLevel: "debug",
			userAgent: "UA/1.0",
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: 45,
		},
		// 各拓展的设置搬进它自己的文件,开关留下(同上)
		extensions: { "dev-bridge": { enabled: true, settings: { token: "t" } } },
		defaults: {
			features: { live: true, liveEnd: true, liveEndExtras: { wordcloud: true } },
			// 过滤键改名(㉑a):四个类型开关与两个白名单换成 1.0 的名字(`feature-renames.test.ts` 钉细节,这里让摘要认得到这一步)
			// 两个直播阈值搬成 superchat / membership 两段(㉓d,`membership-moves.test.ts` 钉细节):旧金额 30 元、旧等级 2(提督以上)
			filters: {
				blockForward: true,
				blockKeywords: ["广告"],
				whitelistKeywords: ["新歌"],
				minScPrice: 30,
				minGuardLevel: 2,
			},
			// 直播拆键:pushTime / restartPush 拆进 liveStreaming / liveStart 两段(`live-split.test.ts` 钉细节,这里让摘要认得到这一步)
			schedule: { pushTime: 3, restartPush: true },
			// 最老一代的扁平 AI 连接字段、历代旧默认模板
			ai: { apiKey: "sk-old", baseUrl: "https://api.example.com", model: "m" },
			templates: {
				liveEnd: "{name} 下播了，直播时长 {duration}",
				// 上舰文案搬成 `membership.guard`(㉓d):舰长改过文案(-key 老写法)又填了图片,提督没动,总督只改了文案
				guardBuy: {
					enable: true,
					captain: {
						imageUrl: "https://img.example.com/captain.png",
						template: "-uname 登上了 -mname 的船",
					},
					commander: { imageUrl: "", template: "{uname} 成为了 {mname} 的提督！" },
					governor: { imageUrl: "", template: "总督 {uname} 驾到,档位 {guard}" },
				},
			},
			// 默认文案账本:上舰那几条换成新路径两条(同上)
			templateDefaultsSeen: {
				liveEnd: "x1",
				"guardBuy.captain.template": "1n2b5zl",
				"guardBuy.captain.imageUrl": "ztntfp",
			},
			// 卡片样式搬成 `cards`、按卡种那一层取消、指向自建皮肤的指针回默认(㉔e,`card-moves.test.ts` 钉细节,
			// 这里让摘要认得到这一步):直播卡种那份封面盖过基准那份,退役的字体与别的卡种下的东西丢掉。
			cardStyle: { enabled: true, font: "OldFont", liveCoverImages: ["base-cover.png"] },
			cardStyleByKind: { live: { liveCoverImages: ["live-cover.png"] }, sc: { enabled: false } },
			cardSkin: "my-old-skin",
			cardSkinKnobs: { "my-old-skin": { accent: "#ff0000" }, default: { accent: "#00ff00" } },
		},
		// 0.9.1 的「范围 + 白名单」
		linkParsing: {
			enabled: true,
			scope: "selected",
			targets: [{ targetId: "22222222-2222-4222-8222-222222222222" }],
		},
	}),
	"state/subscriptions.json": JSON.stringify([
		{
			id: "33333333-3333-4333-8333-333333333333",
			uid: "12345",
			// 0.x 的分组(一串名字)→ 标签表 + tagIds(ADR-0034)
			groups: ["游戏", " 杂谈 "],
			routing: {
				live: ["22222222-2222-4222-8222-222222222222"],
				liveEnd: [],
				wordcloud: ["22222222-2222-4222-8222-222222222222"],
			},
			atAll: { live: { "22222222-2222-4222-8222-222222222222": true } },
			// 直播拆键:这条订阅自己写了 pushTime 与 restartPush
			overrides: {
				schedule: { pushTime: 5, restartPush: false },
				// 逐订阅的阈值与上舰文案(㉓d):覆盖里写的出厂值照样搬;逐订阅文案里更早一代的默认原文不经 0.x 的旧默认迁移
				filters: { blockDraw: true, whitelistRegex: ["^上新"], minScPrice: 0, minGuardLevel: 3 },
				// 逐订阅的卡片样式与皮肤指针(㉔e):同一套并法,指针与孤儿旋钮同样处理
				cardStyleByKind: { live: { liveCoverImages: ["sub-cover.png"] } },
				cardSkin: "my-old-skin",
				cardSkinKnobs: { "my-old-skin": { accent: "#0000ff" } },
				templates: {
					guardBuy: {
						enable: true,
						captain: { imageUrl: "", template: "{user} 成为了 {mastername} 的舰长！" },
						commander: {
							imageUrl: "https://img.example.com/commander.png",
							template: "{uname} 成为了 {mname} 的提督！",
						},
						governor: { imageUrl: "", template: "-uname 就任 -mname 总督" },
					},
				},
			},
		},
	]),
	// 拓展订阅:只作迁移输入,迁移时和上面那份合成新代里的一个 `config/subscriptions.json`,自己不进新代。
	"state/extension-subscriptions.json": "[]",
	// v1 的连接与目标:第二遍会把它们改写成最新的形状。
	"state/connections.json": JSON.stringify([
		{
			id: "11111111-1111-4111-8111-111111111111",
			name: "NapCat",
			enabled: true,
			platform: "onebot",
			config: { transport: "http", baseUrl: "http://127.0.0.1:3000" },
		},
	]),
	"state/targets.json": JSON.stringify([
		{
			id: "22222222-2222-4222-8222-222222222222",
			name: "主群",
			adapterId: "11111111-1111-4111-8111-111111111111",
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "111" },
		},
	]),
	"state/adapters.json": "[]",
	// 资料缓存:拓展订阅的头像是同源相对地址、B 站的是远端网址 —— 第二遍换成图库引用 / 挪到 avatarUrl。
	"state/sub-runtime.json": JSON.stringify({
		"sub-1": {
			cachedProfile: {
				name: "B 站甲",
				avatar: BILI_AVATAR_URL,
				sign: "",
				fans: 10,
				lastRefreshedAt: "2026-09-30T00:00:00.000Z",
			},
			roomId: "21000000",
		},
		"sub-2": {
			cachedProfile: {
				name: "抖音乙",
				avatar: `/api/subs/sub-2/avatar?v=${createHash("sha256").update(JPEG_BYTES).digest("hex").slice(0, 12)}`,
				sign: "",
				lastRefreshedAt: "2026-09-30T00:00:00.000Z",
			},
		},
	}),
	// 0.x 按 uid 回指的待审草稿:第二遍换成订阅 id。
	"state/roast-drafts.json": JSON.stringify([
		{
			id: "ab",
			kind: "solo",
			uid: "12345",
			days: 7,
			targets: ["22222222-2222-4222-8222-222222222222"],
			result: { uid: "12345", text: "锐评" },
			createdAt: "2026-09-30T00:00:00.000Z",
			expiresAt: "2026-10-02T00:00:00.000Z",
		},
	]),
	"secrets/master.key": "ab".repeat(32),
	"secrets/kdf.salt": "cd".repeat(16),
	"secrets/config-secrets.enc": "enc",
	"secrets/cookies.json": "{}",
	// 坏行原样留着;0.x 的老行(一行 = 一个目标 × 一条消息)第二遍改写成现在的行。
	"history/2026-09-30.jsonl": `{"id":1}\n${JSON.stringify({
		id: "44444444-4444-4444-8444-444444444444",
		ts: "2026-09-30T01:00:00.000Z",
		source: "live-summary",
		uid: "12345",
		subscriptionId: "33333333-3333-4333-8333-333333333333",
		targetIds: ["22222222-2222-4222-8222-222222222222"],
		result: {
			ok: true,
			per: [{ targetId: "22222222-2222-4222-8222-222222222222", ok: true, latencyMs: 3 }],
		},
		// 这一行带一张图:`history/img/a.png` 有行引用、行在保留期内,所以复制进图库、`imageRef` 换成 `image`(⑳d);
		// 头像快照是 B 站远端网址,迁移时丢掉。
		payload: { kind: "image", text: "下播了", imageRef: "a.png" },
		uavatarSnapshot: "https://i0.hdslb.com/bfs/face/x.jpg",
	})}\n`,
	// 0.x 的重推原件(⑱c 起 `v` → `version`)。
	"history/repush/2026-09-30/row-1.json":
		'{"v":1,"messages":[{"payload":{"kind":"text","text":"下播了"},"role":"main"}]}',
	"stats/dyn/sub-1.jsonl": '{"k":"post"}\n',
	"stats/live/sub-1.jsonl": '{"k":"start"}\n',
	"stats/seen/sub-1.jsonl": '{"d":"2026-09-30"}\n',
	"stats/since": "2026-09-01",
	// 0.x 按 uid 命名的 B 站统计与粉丝文件(老作品行、字符串峰值):第二遍改名成订阅 id、翻成新行。
	"stats/dyn/12345.jsonl": '{"id":"d1","type":"DYNAMIC_TYPE_AV","ts":"2026-09-30T00:00:00.000Z"}\n',
	"stats/live/12345.jsonl":
		'{"k":"start","ts":"2026-09-30T10:00:00.000Z"}\n{"k":"end","ts":"2026-09-30T12:00:00.000Z","peak":"1.2万"}\n',
	// 两个样本、隔十分钟:运行记录的回填(㉗b)据此在 2026-09-30 的 00 点记 10 分钟。
	"fans/12345.jsonl":
		'{"ts":"2026-09-30T00:00:00.000Z","fans":10}\n{"ts":"2026-09-30T00:10:00.000Z","fans":11}\n',
	"fans/sub-1.jsonl": '{"value":1}\n',
	"assets/card-bg/0123abcd.png": "bg",
	"assets/font/index.json": "{}",
	"assets/font/f1.woff2": "font",
	// 只有浅色模式的界面皮肤,css 上带着 v0.7.0 及之前清洗层烙进去的两句;0.x 的单指针指着它。
	"skins/skin-1/skin.json": JSON.stringify({
		modes: { light: { css: '.x::before{content:"";pointer-events:none;z-index:-1}' } },
	}),
	"skins/active.json": '{"id":"skin-1"}',
	"card-skins/card-1/card-skin.json": "{}",
	"maid-skills/weekly/SKILL.md": "# weekly",
	// 0.x 早期的会话:没有面孔那三格,用过做皮肤的工具。
	"ai/chat/conv-1.json": JSON.stringify({
		id: "conv-1",
		title: "做个皮肤",
		messages: [
			{ role: "assistant", tools: [{ name: "create_skin" }] },
			// 聊天附件:引用的那张换成图库引用,引用的另一张不是图(嗅探不过)从消息里拿掉。
			{ role: "user", images: [CHAT_ATTACHMENT, CHAT_NOT_AN_IMAGE] },
		],
	}),
	"extensions/probe/extension.json": "{}",
	"extensions/probe/index.mjs": "export {}",
	"extensions/load-state.json": "{}",
	"extensions/.marketplace.json": "{}",
	"card-bg-cursors.json": "{}",
	// 残留:上个进程的临时文件、0.x 留下的备份与迁移中间件、storage 旧的缺省目录
	"state/globals.json.bn-tmp.123.abcdef": "half",
	"state/targets.json.bak": "old",
	"state/targets.json.restore.bak": "old",
	"history/2026-09-29.jsonl.tmp.99": "half",
	"bilibili-notify/cookies.json": "{}",
	// 宿主的东西:不属于任何一代
	"versions/1.0.0/index.mjs": "export {}",
	"logs/2026-09-30.jsonl": '{"msg":"x"}\n',
	// 认不得的一级项
	"notes.txt": "hello",
};

/** 期望的去向:相对第 0 代根 → 相对新代根(按 uid 命名的统计文件改名成订阅 id)。 */
const EXPECTED_MOVES: Record<string, string> = {
	"state/globals.json": "config/settings/core.json",
	"state/subscriptions.json": "config/subscriptions.json",
	"state/connections.json": "config/connections.json",
	"state/targets.json": "config/targets.json",
	"state/sub-runtime.json": "runtime/sub-runtime.json",
	"state/roast-drafts.json": "runtime/roast-drafts.json",
	"secrets/master.key": "secrets/master.key",
	"secrets/kdf.salt": "secrets/kdf.salt",
	"secrets/config-secrets.enc": "secrets/config-secrets.enc",
	"secrets/cookies.json": "secrets/cookies.json",
	"history/2026-09-30.jsonl": "history/2026-09-30.jsonl",
	"history/repush/2026-09-30/row-1.json": "history/repush/2026-09-30/row-1.json",
	"stats/dyn/sub-1.jsonl": "stats/posts/sub-1.jsonl",
	"stats/live/sub-1.jsonl": "stats/live/sub-1.jsonl",
	"stats/dyn/12345.jsonl": "stats/posts/33333333-3333-4333-8333-333333333333.jsonl",
	"stats/live/12345.jsonl": "stats/live/33333333-3333-4333-8333-333333333333.jsonl",
	"fans/12345.jsonl": "stats/followers/33333333-3333-4333-8333-333333333333.jsonl",
	"fans/sub-1.jsonl": "stats/followers/sub-1.jsonl",
	"assets/card-bg/0123abcd.png": "library/images/0123abcd.png",
	"assets/font/index.json": "library/fonts/index.json",
	"assets/font/f1.woff2": "library/fonts/f1.woff2",
	"skins/skin-1/skin.json": "skins/dashboard/skin-1/skin.json",
	"skins/active.json": "skins/dashboard/active.json",
	"maid-skills/weekly/SKILL.md": "maid-skills/weekly/SKILL.md",
	"ai/chat/conv-1.json": "ai/conversations/conv-1.json",
	"extensions/probe/extension.json": "extensions/probe/extension.json",
	"extensions/probe/index.mjs": "extensions/probe/index.mjs",
	"extensions/load-state.json": "extensions/load-state.json",
	"extensions/.marketplace.json": "extensions/.marketplace.json",
	"card-bg-cursors.json": "runtime/card-bg-cursors.json",
};

/** 第二遍改写成最新形状的(相对新代根):不再和第 0 代共用一个文件。 */
const REWRITTEN = [
	"ai/conversations/conv-1.json",
	"config/connections.json",
	"config/settings/bilibili.json",
	"config/settings/core.json",
	"config/settings/extensions/dev-bridge.json",
	"config/subscriptions.json",
	"config/targets.json",
	"history/2026-09-30.jsonl",
	"history/repush/2026-09-30/row-1.json",
	"runtime/roast-drafts.json",
	"runtime/sub-runtime.json",
	"skins/dashboard/active.json",
	"skins/dashboard/skin-1/skin.json",
	"stats/followers/33333333-3333-4333-8333-333333333333.jsonl",
	// 粉丝样本压缩(㉘c)改写了粉丝目录里的每一份:这份只有一行读不懂的,压完是个空文件。
	"stats/followers/sub-1.jsonl",
	"stats/live/33333333-3333-4333-8333-333333333333.jsonl",
	// 作品连文件带目录搬进 `stats/posts/`(㉖c):搬了位置的都算改写,哪怕这一份里没有要翻的行。
	"stats/posts/33333333-3333-4333-8333-333333333333.jsonl",
	"stats/posts/sub-1.jsonl",
	// 「在记」小账(㉖f)由迁移推出来写进新代:这一条订阅(uid 12345)有粉丝样本;`stats/seen/` 与 `stats/since` 读完就删,
	// 不进新代。
	"stats/recording/33333333-3333-4333-8333-333333333333.jsonl",
	// 运行记录(㉗b)由迁移从粉丝样本推出来写进新代。
	"uptime/hours.jsonl",
];

async function placeZeroGeneration(): Promise<void> {
	for (const [path, content] of [
		...Object.entries(ZERO_FILES),
		...Object.entries(ZERO_BINARY_FILES),
	]) {
		await mkdir(dirname(join(zero, path)), { recursive: true });
		await writeFile(join(zero, path), content);
	}
	// 开发版 devtools 链进来的拓展:软链,新代里重建同样的一条。
	await mkdir(join(root, "elsewhere"), { recursive: true });
	await symlink(join(root, "elsewhere"), join(zero, "extensions", "dev-bridge"));
}

/** 一棵树的全部文件(相对路径,不跟软链)。 */
async function listTree(dir: string, base = dir): Promise<string[]> {
	const out: string[] = [];
	for (const name of await readdir(dir).catch(() => [] as string[])) {
		const path = join(dir, name);
		const info = await lstat(path);
		if (info.isDirectory()) out.push(...(await listTree(path, base)));
		else out.push(relative(base, path).split(sep).join("/"));
	}
	return out.sort();
}

/** 整棵树(不含代目录)的摘要:路径 + 内容。 */
async function treeDigest(dir: string): Promise<string> {
	const hash = createHash("sha256");
	for (const path of await listTree(dir)) {
		if (path.startsWith("generations/")) continue;
		hash.update(path);
		const info = await lstat(join(dir, path));
		hash.update(info.isSymbolicLink() ? "->link" : await readFile(join(dir, path)));
	}
	return hash.digest("hex");
}

describe("zeroGenerationExists", () => {
	it("空目录、只有宿主的东西 → 没有第 0 代;有 0.x 的一级项 → 有", async () => {
		await mkdir(zero, { recursive: true });
		expect(await zeroGenerationExists(zero)).toBe(false);
		await mkdir(join(zero, "versions"), { recursive: true });
		await mkdir(join(zero, "logs"), { recursive: true });
		expect(await zeroGenerationExists(zero)).toBe(false);
		await mkdir(join(zero, "state"), { recursive: true });
		expect(await zeroGenerationExists(zero)).toBe(true);
	});
});

describe("migrateZeroGeneration", () => {
	it("每条 0.x 路径都到了代布局里该去的地方;没被改写的内容不变", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		// 搬过来的,加上改写时从别的文件拆出来的(B 站的设置从核心那份拆出,ADR-0021 决策 42 下 10-01 的 🔗)。
		const splitOut = [
			"config/settings/bilibili.json",
			"config/settings/extensions/dev-bridge.json",
		];
		// 迁移里那次历史清扫新写的水位线(⑲c):不是搬来的,也不是改写的。聊天附件不整目录搬:被会话引用的那张
		// 复制进图库(⑳b),孤儿与不是图的不带过来。
		// 拓展订阅的头像同理(⑳c):资料缓存引用着的复制进图库,孤儿不带过来。
		// 历史图同理(⑳d):保留期内的行引用着的复制进图库,`history/img/` 不进新代。
		const written = [
			"history/retention.json",
			// 统计的「在记」小账是迁移新写的(㉖f)。
			"stats/recording/33333333-3333-4333-8333-333333333333.jsonl",
			// 运行记录是迁移新写的(㉗b)。
			"uptime/hours.jsonl",
			`images/${CHAT_REF}`,
			`images/${AVATAR_REF}`,
			`images/${HISTORY_REF}`,
		];
		expect(await listTree(target)).toEqual(
			[...Object.values(EXPECTED_MOVES), ...splitOut, ...written, "extensions/dev-bridge"].sort(),
		);
		expect([...report.rewritten].sort()).toEqual(REWRITTEN);
		for (const [from, to] of Object.entries(EXPECTED_MOVES)) {
			if (REWRITTEN.includes(to)) continue;
			expect(await readFile(join(target, to), "utf8"), to).toBe(ZERO_FILES[from]);
		}
	});

	it("连接与目标改写成最新的形状", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		const read = async (name: string) =>
			JSON.parse(await readFile(join(target, "config", name), "utf8")) as unknown[];
		expect(await read("connections.json")).toEqual([
			expect.objectContaining({ kind: "direct", connector: "http", platform: "onebot" }),
		]);
		expect(await read("targets.json")).toEqual([
			expect.objectContaining({
				connectionId: "11111111-1111-4111-8111-111111111111",
				kind: "session",
				address: "111",
			}),
		]);
	});

	it("历史、统计、锐评草稿改写成最新的形状", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		const lines = async (path: string) =>
			(await readFile(join(target, path), "utf8")).split("\n").filter(Boolean);
		const [bad, row] = await lines("history/2026-09-30.jsonl");
		expect(bad).toBe('{"id":1}');
		expect(JSON.parse(row ?? "")).toMatchObject({
			feature: "liveEnd",
			targetId: "22222222-2222-4222-8222-222222222222",
			status: "delivered",
			messages: [{ role: "main", payload: { text: "下播了" } }],
		});
		expect(
			(await lines("stats/posts/33333333-3333-4333-8333-333333333333.jsonl")).map((l) =>
				JSON.parse(l),
			),
		).toEqual([{ id: "d1", hasVideo: true, publishedAt: "2026-09-30T00:00:00.000Z" }]);
		expect(
			JSON.parse((await lines("stats/live/33333333-3333-4333-8333-333333333333.jsonl"))[1] ?? ""),
		).toEqual({
			kind: "end",
			occurredAt: "2026-09-30T12:00:00.000Z",
			peakTotalViewers: 12_000,
		});
		expect(
			JSON.parse(await readFile(join(target, "runtime", "roast-drafts.json"), "utf8")),
		).toEqual([
			expect.objectContaining({
				subscriptionId: "33333333-3333-4333-8333-333333333333",
				result: { subscriptionId: "33333333-3333-4333-8333-333333333333", text: "锐评" },
			}),
		]);
	});

	it("界面皮肤与女仆对话改写成最新的形状", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		const read = async (...path: string[]) =>
			JSON.parse(await readFile(join(target, ...path), "utf8")) as Record<string, unknown>;
		expect(await read("skins", "dashboard", "active.json")).toEqual({ light: "skin-1" });
		const css = JSON.stringify(await read("skins", "dashboard", "skin-1", "skin.json"));
		expect(css).toContain("content");
		expect(css).not.toContain("pointer-events");
		expect(css).not.toContain("z-index");
		expect(await read("ai", "conversations", "conv-1.json")).toMatchObject({
			mode: "skin",
			persona: true,
			skinTarget: "dashboard",
		});
	});

	it("搬过去的每个文件都是复制出来的另一个文件,没有一个和第 0 代共用", async () => {
		// 共用一个文件(硬链接)的话,哪边原地写都会改到另一边。1.0 自己全是换名写,可回退到 0.x 以后
		// 0.x 原地写的那几类(会话、字体清单、封面游标、cookie、皮肤素材、重推原件)会改到新代里。
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		for (const [from, to] of Object.entries(EXPECTED_MOVES)) {
			const same = (await stat(join(target, to))).ino === (await stat(join(zero, from))).ino;
			expect(same, `${to} 不该和第 0 代的 ${from} 是同一个文件`).toBe(false);
		}
		expect(new Set(report.transfers.map((t) => t.method))).toEqual(new Set(["copy", "symlink"]));
		// 聊天附件、拓展订阅头像进图库是复制,不是硬链接:图库靠刷新修改时间做宽限期,硬链接会改到第 0 代那份。
		expect((await stat(join(target, "images", CHAT_REF))).ino).not.toBe(
			(await stat(join(zero, "assets", "chat", CHAT_ATTACHMENT))).ino,
		);
		expect((await stat(join(target, "images", AVATAR_REF))).ino).not.toBe(
			(await stat(join(zero, "avatars", "sub-2.jpeg"))).ino,
		);
		expect((await stat(join(target, "images", HISTORY_REF))).ino).not.toBe(
			(await stat(join(zero, "history", "img", "a.png"))).ino,
		);
	});

	it("聊天附件:被会话引用的逐张复制进图库(记在搬过去的里),会话里的旧 id 换成引用、不是图的拿掉;孤儿不搬,按数量记一句", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		expect(report.transfers.filter((t) => t.from.startsWith("assets/chat/"))).toEqual([
			{ from: `assets/chat/${CHAT_ATTACHMENT}`, to: `images/${CHAT_REF}`, method: "copy" },
		]);
		expect(new Uint8Array(await readFile(join(target, "images", CHAT_REF)))).toEqual(
			new Uint8Array(PNG_BYTES),
		);
		const conv = JSON.parse(
			await readFile(join(target, "ai", "conversations", "conv-1.json"), "utf8"),
		) as { messages: Array<{ images?: string[] }> };
		expect(conv.messages[1]?.images).toEqual([CHAT_REF]);
		expect(report.skipped.filter((s) => s.path === "assets/chat").map((s) => s.reason)).toEqual([
			expect.stringContaining("不整目录进新代"),
			expect.stringContaining("1 张聊天附件对不上"),
			expect.stringContaining("1 张聊天附件没有任何会话引用"),
		]);
	});

	it("拓展订阅头像:资料缓存引用着的复制进图库(记在搬过去的里),资料里换成引用、B 站的网址挪到 avatarUrl;孤儿不搬,按数量记一句", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		expect(report.transfers.filter((t) => t.from.startsWith("avatars/"))).toEqual([
			{ from: "avatars/sub-2.jpeg", to: `images/${AVATAR_REF}`, method: "copy" },
		]);
		expect(new Uint8Array(await readFile(join(target, "images", AVATAR_REF)))).toEqual(
			new Uint8Array(JPEG_BYTES),
		);
		const runtime = JSON.parse(
			await readFile(join(target, "runtime", "sub-runtime.json"), "utf8"),
		) as Record<string, { cachedProfile?: Record<string, unknown>; roomId?: string }>;
		expect(runtime["sub-2"]?.cachedProfile).toMatchObject({ name: "抖音乙", avatar: AVATAR_REF });
		expect(runtime["sub-1"]?.cachedProfile).toMatchObject({
			name: "B 站甲",
			avatarUrl: BILI_AVATAR_URL,
		});
		expect(runtime["sub-1"]?.cachedProfile).not.toHaveProperty("avatar");
		expect(runtime["sub-1"]?.roomId).toBe("21000000");
		// 头像目录不整个搬进新代。
		expect(existsSync(join(target, "avatars"))).toBe(false);
		expect(report.skipped.filter((s) => s.path === "avatars").map((s) => s.reason)).toEqual([
			expect.stringContaining("不整目录进新代"),
			"1 个头像文件没有任何资料引用,没带过来",
		]);
	});

	it("历史图:保留期内的行引用着的复制进图库(记在搬过去的里),行里 imageRef 换成 image、远端头像网址丢掉;历史图目录不整个搬,记一句", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		expect(report.transfers.filter((t) => t.from.startsWith("history/img/"))).toEqual([
			{ from: "history/img/a.png", to: `images/${HISTORY_REF}`, method: "copy" },
		]);
		expect(new Uint8Array(await readFile(join(target, "images", HISTORY_REF)))).toEqual(
			new Uint8Array(HISTORY_IMAGE_BYTES),
		);
		const [, line] = (await readFile(join(target, "history", "2026-09-30.jsonl"), "utf8")).split(
			"\n",
		);
		const row = JSON.parse(line ?? "") as {
			messages: { payload: Record<string, unknown> }[];
		} & Record<string, unknown>;
		expect(row.messages[0]?.payload).toEqual({ kind: "image", text: "下播了", image: HISTORY_REF });
		expect(row).not.toHaveProperty("uavatarSnapshot");
		expect(existsSync(join(target, "history", "img"))).toBe(false);
		expect(report.skipped.filter((s) => s.path === "history/img").map((s) => s.reason)).toEqual([
			expect.stringContaining("不整目录进新代"),
		]);
	});

	it("开发版链进来的拓展:新代里重建同样的一条软链,不拷内容", async () => {
		await placeZeroGeneration();

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		const link = join(target, "extensions", "dev-bridge");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readlink(link)).toBe(join(root, "elsewhere"));
	});

	it("残留、卡片皮肤、宿主的东西不带过来,都记进报告;认不得的一级项也记;拓展订阅只作输入、也记进报告", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		expect(report.skipped.map((s) => s.path).sort()).toEqual(
			[
				"assets/chat",
				"assets/chat",
				"assets/chat",
				"avatars",
				"avatars",
				"bilibili-notify",
				"card-skins",
				"history/2026-09-29.jsonl.tmp.99",
				"history/img",
				"notes.txt",
				"state/adapters.json",
				"state/extension-subscriptions.json",
				"state/globals.json.bn-tmp.123.abcdef",
				"state/targets.json.bak",
				"state/targets.json.restore.bak",
				// 粉丝样本压缩(㉘c):`fans/sub-1.jsonl` 里那一行 `{"value":1}` 读不懂,丢掉、合起来记一条。
				"stats/followers",
			].sort(),
		);
		for (const skipped of report.skipped) expect(skipped.reason.length).toBeGreaterThan(0);
	});

	it("第 0 代一个字节都没动", async () => {
		await placeZeroGeneration();
		const before = await treeDigest(zero);

		await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });

		expect(await treeDigest(zero)).toBe(before);
	});

	it("按一级项报进度,最后一次是全部做完", async () => {
		await placeZeroGeneration();
		const seen: MigrationProgress[] = [];

		await migrateZeroGeneration({
			zeroRoot: zero,
			targetDir: target,
			now: NOW,
			onProgress: (progress) => seen.push(progress),
		});

		expect(seen.length).toBeGreaterThan(2);
		const last = seen.at(-1);
		expect(last?.done).toBe(last?.total);
		for (const progress of seen) expect(progress.label.length).toBeGreaterThan(0);
		expect(seen.map((p) => p.done)).toEqual([...seen.map((p) => p.done)].sort((a, b) => a - b));
	});

	it("产出变了就得抬 MIGRATION_REVISION", async () => {
		await placeZeroGeneration();

		const report = await migrateZeroGeneration({ zeroRoot: zero, targetDir: target, now: NOW });
		const hash = createHash("sha256");
		for (const t of [...report.transfers].sort((a, b) => a.from.localeCompare(b.from))) {
			hash.update(`${t.from} -> ${t.to} (${t.method})\n`);
		}
		for (const s of [...report.skipped].sort((a, b) => a.path.localeCompare(b.path))) {
			hash.update(`skip ${s.path}\n`);
		}
		for (const path of [...report.rewritten].sort()) {
			hash.update(`rewrite ${path}\n`).update(await readFile(join(target, path)));
		}
		// 迁移新写的历史水位线不算改写、不在 `rewritten` 里,单独算进来:清扫怎么定水位线变了,也得抬修订号。
		hash
			.update("history/retention.json\n")
			.update(await readFile(join(target, "history", "retention.json")));

		// 迁移的产出一变,这一行就红:把 MIGRATION_REVISION 加 1,再把这里的两个值一起更新。
		// 只改了摘要、没抬修订号的话,开发期已经迁出来的那一代不会重迁,新代码读着旧产出。
		expect({ revision: MIGRATION_REVISION, output: hash.digest("hex") }).toEqual({
			revision: 35,
			output: "f352f3a0104bc0c2ad837a0d172562abd184c9ed66ab397d90868c9b6da7fcaa",
		});
	});
});
