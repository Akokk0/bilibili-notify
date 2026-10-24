/**
 * 第 0 代 → 新的一代(ADR-0022 决策 4、7)。第 0 代就是 0.x 留在宿主根上的那些文件,它只读、一个字节不动;
 * 新的一代由调用方(`runtime/generations.ts` 的 `createGeneration`)在 `.partial` 里交给这里填。
 *
 * 两遍:先照 `ZERO_GENERATION_MOVES` 把 0.x 的布局(`ZERO_GENERATION_LAYOUT`)搬进代的布局(`runtime/roots.ts`
 * 的 `DATA_ROOT_LAYOUT`),再逐文件把 0.x 各个版本留下的形状改写成 0.x 最新的形状(⑥c 起,一族一族收进来)。
 * 旧格式的知识只住在这个模块里,各个 store 开机只认最新的形状。改写写的是新文件(原子换名),不原地写。
 *
 * 怎么搬:**一律复制,不硬链接**(决策 7 下 2026-10-06 的 🔗)。硬链接是两代共用一个文件,哪边原地写都会
 * 改到另一边;1.0 自己全是换名写,但回退到 0.x 以后 0.x 原地写的那几类(字体清单、封面游标、cookie、
 * 皮肤素材、重推原件)会改到新代里 —— 能不能链取决于新旧两边的写法,旧版本的写法我们管不了。
 * 软链(开发版 devtools 链进来的拓展,指向仓里构建好的 dist)在新代里重建同样的一条、不拷内容。拓展订阅的头像、历史图(与重推原件自存的图)不整目录搬:被资料缓存 / 保留期内的
 * 历史行与重推原件引用的逐张复制进图库 `images/`(见 `profile-avatars.ts`、`history-images.ts`)。
 * 上个进程的残留、0.x 的备份与迁移中间件、卡片皮肤(不迁,决策 12)、女仆技能与女仆对话(连同聊天附件,
 * 不迁,决策 4)不带过来,都记进报告。
 */

import { access, lstat, mkdir, readdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/internal";
import {
	copyFileAtomic,
	type KeyMaterialRead,
	readKeyMaterial,
	syncDirectory,
} from "@bilibili-notify/storage";
import {
	CONFIG_DIR,
	CORE_SETTINGS_FILE,
	extensionSettingsFile,
	integrationSettingsFile,
} from "../config/store.js";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { CARD_BG_CURSORS_FILE, CARD_BG_DIR } from "../runtime/card-assets.js";
import { FONT_DIR } from "../runtime/font-assets.js";
import { ROAST_DRAFTS_FILE } from "../runtime/roast-draft-store.js";
import { type DataRootKey, dataPath, HOST_ROOT_LAYOUT } from "../runtime/roots.js";
import { SUBSCRIPTION_STATE_FILE } from "../runtime/subscription-state-store.js";
import { DASHBOARD_SKINS_DIR } from "../skins/store.js";
import { BILI_LOGIN_TARGET, migrateBiliLogin } from "./bili-login.js";
import { migrateConnectionFiles } from "./connections.js";
import { leftoverReason } from "./files.js";
import { migrateFollowerCompression } from "./followers.js";
import {
	migrateHistoryDayFiles,
	migrateRepushSnapshotFiles,
	sweepMigratedHistory,
} from "./history.js";
import { createHistoryImages, historyInputReason } from "./history-images.js";
import { ZERO_GLOBAL_LIVE_FACTS } from "./live-split.js";
import { migrateProfileAvatars } from "./profile-avatars.js";
import { migrateRecordingLedger } from "./recording.js";
import { migrateRoastDraftsFile } from "./roast-drafts.js";
import { migrateSecretBag } from "./secrets.js";
import {
	clearMasterTargetUnlessPrivate,
	migrateSettingsFiles,
	readMigratedRetentionDays,
	readZeroLiveFacts,
} from "./settings.js";
import { migrateDashboardSkins } from "./skins.js";
import { migrateStatsFiles } from "./stats.js";
import { migrateSubscriptionState } from "./subscription-state.js";
import {
	type BiliSubscriptionKey,
	migrateSubscriptionFiles,
	readBiliSubscriptionKeys,
} from "./subscriptions.js";
import { migrateUptime } from "./uptime.js";

/**
 * 迁移修订号(见 `runtime/generations.ts`):开发期每改一次迁移的产出(搬什么、搬到哪、怎么搬、丢下什么、
 * 格式怎么变)就加 1,开发期迁出来的那一代据此重迁。只比一样不一样。alpha.1 起冻住。
 * `__tests__/zero-generation.test.ts` 的最后一条钉着「产出变了必须抬它」。
 *
 * 39 = 迁出来的推送目标不再带 `platform`(平台只在连接上),端点目标也不再带 `scope`
 * (`config/targets.json` 因此少了这两格,摘要变)。
 * 40 = 连接换成 `adapterKey` / `settings` / `platformSnapshot` 的新形状(`connections.json` 的形状变),
 * `testStatus` 两处(连接、目标)都不带过来。
 * 41 = B 站登录从 secrets/cookies.json 转成 secrets/bilibili/secrets.enc(cookie 罐进 http.cookies 键、续期令牌进
 * refreshToken 键);解不开的不带过来。
 * 42 = 核心设置拆掉 `app`:日志的四格进 `logging`(日志等级表里 dynamic / live 并成 bilibili)、粉丝轮询的 cron 成顶层
 * `profileRefreshCron`(`config/settings/core.json` 因此没有 `app`,摘要变)。
 * 43 = 默认文案账本从 `defaults.templateDefaultsSeen` 上提成核心设置顶层的 `templatesSeen`(`core.json` 里账本换了位置,摘要变)。
 * 44 = AI 设置整段从 `defaults.ai` 上提成核心设置顶层的 `ai`(里面的键一个不动;`core.json` 里 AI 换了位置,摘要变)。
 * 45 = 特别关注名单 `specialUsers` → `specialViewers`(条目 `{ uid, kinds, template? }` → `{ id, features }`,`template` 丢掉),
 * 两把特性键 `specialDanmaku` / `specialUserEnter` → `viewerChat` / `viewerEnter`(设置的开关与文案、订阅的路由与覆盖、
 * 默认文案账本、历史行的 `feature`;统计「在记」账里直播那一格改用冻住的 0.x 旧读法)。
 * 46 = 0.x 的女仆技能 `maid-skills/`、女仆对话 `ai/chat/` 与聊天附件 `assets/chat/` 不再带进新代,留在第 0 代(各记一条没带过来的);
 * 会话改写与附件进图库那一步撤掉(新代没有 `maid-skills/`、`ai/`,图库里没有 0.x 的附件)。
 * 47 = 链接设置 `linkParsing` 成了 `linkPreview` 五格(`enabled`、`isOnByDefault`、`replyForm`、`byTarget`、`cooldownSec`;
 * 0.x 的 `defaults.parse` / `defaults.form` / `groups` / `cooldownSeconds` 各归其位,回复形式 `miniapp` 叫 `nativeShare`;
 * `config/settings/core.json` 因此没有 `linkParsing`,摘要变)。
 * 48 = 其余六条直播文案的占位符改写(`-key` → `{key}`,`{mastername}` / `{uname}` / `{mdn}` → `{name}` / `{viewer}` / `{fanclub}`;
 * 设置与订阅覆盖里的文案变,账本里特别弹幕 / 特别进场 / 弹幕总结三条的旧默认指纹换新,摘要变)。
 * 49 = 重推原件里的小程序卡改成原生分享(`miniapp-card` → `native-share`,`desc` / `picUrl` / `path` / `jumpUrl` →
 * `description` / `imageUrl` / `pagePath` / `webUrl`,补 B 站 QQ 小程序的 `appId`;`history/repush/` 里这种原件的形状变)。
 * 50 = 内置人格的默认文案改成叫法变量(3b-35;`config/settings/core.json` 的 AI 人格文案变,摘要变)。
 * 51 = 资料缓存换成 `CreatorProfile` 形状并改名 `runtime/subscription-state.json`:记录只留资料,
 * 丢 `fansBaseline` / `followed` / `followError`,B 站房号拆进 B 站状态 `room:<uid>`,B 站远端头像地址不再保留。
 */
export const MIGRATION_REVISION = 51;

/** 迁移清空了主人目标时,记在「没带过来的」里的那一项(首访提示靠它认)。 */
export const MASTER_TARGET_SKIPPED_PATH = "master-target";
const MASTER_TARGET_CLEARED_REASON =
	"主人目标指向的不是私聊目标(群,或目标已经不在),已清空,请重新选一个私聊目标";

/**
 * 0.x 的布局(第 0 代):宿主根上的一级项。只作迁移的输入 —— 1.0 的代码只认代的布局。
 */
export const ZERO_GENERATION_LAYOUT = {
	state: "设置、两份订阅、连接、目标,和程序自己记的小状态(订阅运行态、锐评草稿)",
	secrets: "主密钥、口令派生盐、AI 的 apiKey、B 站 cookie",
	history: "推送历史 <日>.jsonl、历史图 img/、重推原件 repush/<日>/",
	stats: "作品 dyn/、直播 live/、seen/(按订阅一个 jsonl)与水位线 since",
	fans: "粉丝时序,按订阅一个 jsonl",
	assets: "卡片背景 card-bg/、聊天附件 chat/、字体 font/",
	avatars: "拓展订阅的头像,按订阅 id",
	skins: "界面皮肤 <id>/ 与 active.json",
	"card-skins": "卡片皮肤 <id>/",
	"maid-skills": "主人的女仆技能 <name>/SKILL.md",
	ai: "女仆对话 chat/",
	extensions: "已装的拓展包、失败记账 load-state.json、市场来源 .marketplace.json",
	"card-bg-cursors.json": "直播封面的轮换游标",
} as const;

export type ZeroGenerationKey = keyof typeof ZERO_GENERATION_LAYOUT;

/** 第 0 代里的路径。第一段只能是 `ZERO_GENERATION_LAYOUT` 里的键。 */
export function zeroPath(zeroRoot: string, key: ZeroGenerationKey, ...rest: string[]): string {
	return join(zeroRoot, key, ...rest);
}

/** 代布局里的一个位置:第一段是代的一级项。 */
type Destination = readonly [DataRootKey, ...string[]];

type ZeroMove =
	/**
	 * 整个搬到一处。`inputs` 给了,就是这棵目录里有些东西只作迁移的输入、不随目录搬:逐个路径(相对这棵目录,`/` 分隔)
	 * 问它,回一句话就是不搬、为什么(同一句话的合并成一条记进没带过来的,按数量说,不逐个文件列)。
	 */
	| { kind: "move"; to: Destination; label: string; inputs?: (path: string) => string | undefined }
	/**
	 * 一级项底下的东西各去各处(`state/` 里的文件分进 config / runtime)。`inputs` 是只作迁移输入、
	 * 不进新代的那几个(名字 → 为什么):只作迁移输入的,或不迁的。
	 */
	| {
			kind: "split";
			children: Readonly<Record<string, Destination>>;
			inputs?: Readonly<Record<string, string>>;
			label: string;
	  }
	/** 不迁。 */
	| { kind: "drop"; reason: string }
	/**
	 * 整个只作迁移的输入、不进新代:某一步改写时读它(拓展订阅的头像,资料缓存引用到哪个才复制哪个),
	 * 在就记进「没带过来的」,`reason` 写清它去了哪。和 `drop` 的区别只在语义:`drop` 是不要了,这个是读了再决定。
	 */
	| { kind: "input"; reason: string };

/**
 * 0.x 的每个一级项去哪。`satisfies` 钉住 0.x 布局里的每一项都有去向:布局多一项,这里不写就编译不过。
 * 去向一律引用各个仓自己导出的位置(`CONFIG_DIR`、`FOLLOWERS_DIR`……),迁移写到哪、仓就从哪读,
 * 两边只有一个真源。
 */
const ZERO_GENERATION_MOVES = {
	state: {
		kind: "split",
		label: "设置与订阅",
		children: {
			"globals.json": CORE_SETTINGS_FILE,
			"subscriptions.json": [...CONFIG_DIR, "subscriptions.json"],
			"connections.json": [...CONFIG_DIR, "connections.json"],
			"targets.json": [...CONFIG_DIR, "targets.json"],
			"sub-runtime.json": SUBSCRIPTION_STATE_FILE,
			"roast-drafts.json": ROAST_DRAFTS_FILE,
		},
		inputs: {
			"adapters.json": "connections.json 的旧名:没有 connections.json 时迁移读它一次,不进新代",
			"extension-subscriptions.json":
				"拓展订阅:迁移读它一次、和 subscriptions.json 合成一个文件(ADR-0021 决策 15),不进新代",
		},
	},
	secrets: {
		kind: "move",
		to: ["secrets"],
		label: "密钥",
		inputs: (path) =>
			path === "cookies.json"
				? "B 站登录:迁移读它一次、转成 secrets/bilibili/secrets.enc,不进新代"
				: undefined,
	},
	history: { kind: "move", to: ["history"], label: "推送历史", inputs: historyInputReason },
	stats: { kind: "move", to: ["stats"], label: "统计" },
	fans: { kind: "move", to: FOLLOWERS_DIR, label: "粉丝时序" },
	assets: {
		kind: "split",
		label: "素材",
		children: {
			"card-bg": CARD_BG_DIR,
			font: FONT_DIR,
		},
		inputs: {
			chat: "聊天附件随女仆对话不迁(ADR-0022 决策 4),留在第 0 代",
		},
	},
	avatars: {
		kind: "input",
		reason:
			"拓展订阅的头像:迁移读一次,被资料缓存引用的逐张复制进图库 images/(记在搬过去的里)、其余不带过来,不整目录进新代",
	},
	skins: { kind: "move", to: DASHBOARD_SKINS_DIR, label: "界面皮肤" },
	"card-skins": { kind: "drop", reason: "卡片皮肤不迁(ADR-0022 决策 12)" },
	"maid-skills": {
		kind: "drop",
		reason: "女仆技能不迁(ADR-0022 决策 4),自己写的技能留在第 0 代;内置技能跟版本走,不受影响",
	},
	ai: {
		kind: "drop",
		reason: "女仆对话不迁(ADR-0022 决策 4),留在第 0 代;新的一代从空的对话开始",
	},
	extensions: { kind: "move", to: ["extensions"], label: "拓展" },
	"card-bg-cursors.json": { kind: "move", to: CARD_BG_CURSORS_FILE, label: "直播封面的轮换游标" },
} as const satisfies Record<ZeroGenerationKey, ZeroMove>;

/** 0.x 根上认得、但不属于任何一代的一级项:宿主件,和装各代的那一层。 */
const HOST_NAMES: ReadonlySet<string> = new Set(Object.keys(HOST_ROOT_LAYOUT));

/** 0.x 根上认得的残留目录:storage 旧的缺省布局(三条密钥路径由宿主给全以后就没人写了)。 */
const ZERO_LEFTOVER_DIRS: ReadonlySet<string> = new Set(["bilibili-notify"]);

export interface MigrationProgress {
	done: number;
	total: number;
	/** 正在搬的那一项,给「正在搬家」那句话用。 */
	label: string;
}

export interface ZeroMigrationResult {
	/**
	 * 搬过去的每个文件(相对第 0 代根 / 新代根,`/` 分隔)与搬法:`copy` 复制、
	 * `symlink` 重建同样的一条软链。
	 */
	transfers: { from: string; to: string; method: "copy" | "symlink" | "convert" }[];
	/** 没带过来的,和为什么。 */
	skipped: { path: string; reason: string }[];
	/**
	 * 搬过来之后改写成最新形状的文件(相对新代根,`/` 分隔)。统计文件改了名的记新名字 —— 旧名字在
	 * `transfers` 里,搬过来之后被并进新名字、删掉了。0.x 自己已经并好、只差删 uid 那份的,只删不写,
	 * 不记在这里(修订号的摘要因此也看不到这一步)。迁移新写的历史水位线 `history/retention.json` 不是改写,也不记在这里
	 * (摘要那条测试单独把它算进去)。
	 */
	rewritten: string[];
}

export interface MigrateZeroGenerationOptions {
	/** 第 0 代的根,也就是宿主根。只读。 */
	zeroRoot: string;
	/** 往这里填:新代的 `.partial`。 */
	targetDir: string;
	/** 主密钥的口令(`BN_COOKIE_KEY`,没配就不传):解加密袋要用第 0 代那把密钥。 */
	passphrase?: string;
	onProgress?: (progress: MigrationProgress) => void;
	/** 此刻:迁移里那次历史清扫按它算哪几天过了保留期。缺省读系统时钟;注入口只留给测试。 */
	now?: Date;
}

/**
 * 只读地取第 0 代的密钥(迁移还没做完时给会话签名用):和新代的 provider 选同一种、拿到同一把
 * (迁移逐字节搬过去);缺了回 missing,绝不往第 0 代写。
 */
export function readZeroGenerationKey(
	zeroRoot: string,
	passphrase: string | undefined,
): Promise<KeyMaterialRead> {
	return readKeyMaterial({
		passphrase,
		keyPath: zeroPath(zeroRoot, "secrets", "master.key"),
		saltPath: zeroPath(zeroRoot, "secrets", "kdf.salt"),
	});
}

/** 宿主根上有没有 0.x 的数据:0.x 布局里任何一项在就算有。 */
export async function zeroGenerationExists(zeroRoot: string): Promise<boolean> {
	for (const key of Object.keys(ZERO_GENERATION_LAYOUT) as ZeroGenerationKey[]) {
		if (await exists(zeroPath(zeroRoot, key))) return true;
	}
	return false;
}

export async function migrateZeroGeneration(
	opts: MigrateZeroGenerationOptions,
): Promise<ZeroMigrationResult> {
	const report: ZeroMigrationResult = { transfers: [], skipped: [], rewritten: [] };
	const context = { zeroRoot: opts.zeroRoot, targetDir: opts.targetDir, report };
	const moves = Object.entries(ZERO_GENERATION_MOVES) as [ZeroGenerationKey, ZeroMove][];
	const total = moves.length + REWRITES.length;

	await mkdir(opts.targetDir, { recursive: true });
	for (const [index, [key, move]] of moves.entries()) {
		const from = zeroPath(opts.zeroRoot, key);
		if (move.kind === "drop" || move.kind === "input") {
			if (await exists(from)) report.skipped.push({ path: key, reason: move.reason });
			continue;
		}
		opts.onProgress?.({ done: index, total, label: move.label });
		if (!(await exists(from))) continue;
		if (move.kind === "move") {
			const scope = move.inputs && { root: from, inputs: move.inputs };
			await transfer(context, from, dataPath(opts.targetDir, ...move.to), scope);
			continue;
		}
		for (const name of (await readdir(from)).sort()) {
			const destination = move.children[name];
			const input = move.inputs?.[name];
			if (input) {
				skip(context, join(from, name), input);
			} else if (destination) {
				await transfer(context, join(from, name), dataPath(opts.targetDir, ...destination));
			} else {
				skip(context, join(from, name), leftoverReason(name) ?? "认不得,没带过来");
			}
		}
	}

	for (const name of (await readdir(opts.zeroRoot)).sort()) {
		if (name in ZERO_GENERATION_MOVES || HOST_NAMES.has(name)) continue;
		skip(
			context,
			join(opts.zeroRoot, name),
			ZERO_LEFTOVER_DIRS.has(name)
				? "storage 旧的缺省目录"
				: (leftoverReason(name) ?? "认不得,没带过来"),
		);
	}

	// 同一个文件被好几步改写(粉丝样本:统计那步改名并档、压缩那步改形),汇报里只记一次。
	const rewrittenSeen = new Set<string>();
	for (const [index, rewrite] of REWRITES.entries()) {
		opts.onProgress?.({ done: moves.length + index, total, label: rewrite.label });
		for (const path of await rewrite.run(opts, report)) {
			const name = portable(relative(opts.targetDir, path));
			if (rewrittenSeen.has(name)) continue;
			rewrittenSeen.add(name);
			report.rewritten.push(name);
		}
	}
	// 图库里的图是迁移器逐张直接写的(文件各自 fsync,目录没逐个同步,见 `image-library.ts`):整个目录同步一次。
	const imagesDir = dataPath(opts.targetDir, "images");
	if (await exists(imagesDir)) await syncDirectory(imagesDir);
	await syncDirectory(opts.targetDir);
	opts.onProgress?.({ done: total, total, label: "搬完了" });
	return report;
}

/**
 * 搬完位置之后逐文件改写,一族一个。**顺序有依赖**:连接与目标(托管目标会改写订阅里的目标 id,由配置仓
 * 开机时做)→ 设置 → 主人目标(要两边都迁好)→ 订阅 → 推送历史 → 要订阅列表的统计与锐评草稿 → 订阅资料、皮肤、密钥、B 站登录(不依赖别的,放最后)。
 * 每一项回它改写过的文件(绝对路径)。
 */
const REWRITES: readonly {
	label: string;
	run: (opts: MigrateZeroGenerationOptions, report: ZeroMigrationResult) => Promise<string[]>;
}[] = [
	{
		label: "连接与推送目标",
		run: (opts) =>
			migrateConnectionFiles({
				configDir: dataPath(opts.targetDir, ...CONFIG_DIR),
				adaptersPath: zeroPath(opts.zeroRoot, "state", "adapters.json"),
			}),
	},
	{
		label: "设置",
		run: (opts) =>
			migrateSettingsFiles({
				core: dataPath(opts.targetDir, ...CORE_SETTINGS_FILE),
				bilibili: dataPath(opts.targetDir, ...integrationSettingsFile(BILIBILI_SOURCE_KEY)),
				extension: (id) => dataPath(opts.targetDir, ...extensionSettingsFile(id)),
			}),
	},
	{
		// 要看迁好的设置与迁好的目标表,所以排在两者之后。清掉的记进「没带过来的」,首访提示据此多说一句。
		label: "主人目标",
		run: async (opts, report) => {
			const core = dataPath(opts.targetDir, ...CORE_SETTINGS_FILE);
			const cleared = await clearMasterTargetUnlessPrivate({
				core,
				targets: join(dataPath(opts.targetDir, ...CONFIG_DIR), "targets.json"),
			});
			if (!cleared) return [];
			report.skipped.push({
				path: MASTER_TARGET_SKIPPED_PATH,
				reason: MASTER_TARGET_CLEARED_REASON,
			});
			return [core];
		},
	},
	{
		label: "订阅",
		run: async (opts) =>
			migrateSubscriptionFiles({
				configDir: dataPath(opts.targetDir, ...CONFIG_DIR),
				extensionSubscriptionsPath: zeroPath(
					opts.zeroRoot,
					"state",
					"extension-subscriptions.json",
				),
				// 直播拆键要拆键之前的全局值(设置那一步已经把 `pushTime` 折成间隔、反推不出),取第 0 代的。
				globalLive: await readZeroLiveFacts(
					zeroPath(opts.zeroRoot, "state", "globals.json"),
					ZERO_GLOBAL_LIVE_FACTS,
				),
			}),
	},
	{
		label: "推送历史",
		run: async (opts, report) => {
			// 先替主人跑一次清扫:定好水位线,过了保留期的重推原件整天目录不带过来(ADR-0022 决策 9)。保留天数读新代里
			// 迁好的设置(「设置」那一步在前面)。清扫不碰图,也不依赖行的形状,所以排在日文件的改写之前 —— 图格怎么迁
			// 要看日子在水位线的哪一边。
			const swept = await sweepMigratedHistory({
				dataRoot: opts.targetDir,
				retentionDays: await readMigratedRetentionDays(
					dataPath(opts.targetDir, ...CORE_SETTINGS_FILE),
				),
				now: opts.now ?? new Date(),
			});
			// 搬过来又删掉的,从「搬过去的」里拿掉,记进「没带过来的」。
			const snapshotDirs = swept.snapshotDays.map((day) => `history/repush/${day}/`);
			report.transfers = report.transfers.filter(
				({ to }) => !snapshotDirs.some((dir) => to.startsWith(dir)),
			);
			report.skipped.push(...swept.skipped);

			// 日文件(行的形状与图格同一趟)与原件。历史图不整目录搬:保留期内的行与原件引用着的逐张复制进图库,
			// 过了保留期的行拿掉图格、不读图文件,孤儿不搬。
			const images = createHistoryImages({
				zeroDir: zeroPath(opts.zeroRoot, "history"),
				imagesDir: dataPath(opts.targetDir, "images"),
				clearedThrough: swept.clearedThrough,
			});
			const dayFiles = await migrateHistoryDayFiles(opts.targetDir, images);
			const snapshots = await migrateRepushSnapshotFiles(opts.targetDir, images);

			// 有图读不到、整份作废的原件:搬位置时记过一条,删了就拿掉。
			const voided = new Set(
				snapshots.voided.map((path) => portable(relative(opts.targetDir, path))),
			);
			report.transfers = report.transfers.filter(({ to }) => !voided.has(to));

			// 图的账:搬进图库的各记一条(旧路径 → 图库里的引用),没搬的按数量各记一句,不逐个列。
			const done = await images.result();
			for (const { from, ref } of done.copied) {
				report.transfers.push({
					from,
					to: portable(relative(opts.targetDir, dataPath(opts.targetDir, "images", ref))),
					method: "copy",
				});
			}
			if (done.expired > 0) {
				report.skipped.push({
					path: "history/img",
					reason: `${done.expired} 张历史图只被过了保留期的行引用,没带过来(那些行的文字照搬,图格拿掉)`,
				});
			}
			if (done.orphans > 0) {
				report.skipped.push({
					path: "history/img",
					reason: `${done.orphans} 张历史图没有任何一行历史或重推原件引用,没带过来`,
				});
			}
			if (done.dropped > 0) {
				report.skipped.push({
					path: "history/img",
					reason: `${done.dropped} 张历史图对不上(文件不在、不是图库收的图、超过 8MB 或路径不对),已从引用它的行里拿掉`,
				});
			}
			if (voided.size > 0) {
				report.skipped.push({
					path: "history/repush",
					reason: `${voided.size} 份重推原件有图对不上(同上),整份没带过来,那几行补不了了`,
				});
			}
			return [...dayFiles, ...snapshots.rewritten];
		},
	},
	{
		label: "统计",
		run: withBiliSubscriptions((opts, subscriptions) =>
			migrateStatsFiles(opts.targetDir, subscriptions),
		),
	},
	{
		// 在「统计」之后:读它迁好的作品 / 直播 / 粉丝文件与订阅文件,推出老日子的「在记」小账。
		label: "统计的在记",
		run: (opts, report) =>
			migrateRecordingLedger(opts.targetDir, (reason) =>
				report.skipped.push({ path: "stats/recording", reason }),
			),
	},
	{
		// 在「统计」之后:读它迁好的粉丝样本,推出老日子每个小时 BN 跑了多少分钟(运行记录,㉗b)。
		label: "运行记录",
		run: (opts) => migrateUptime(opts.targetDir),
	},
	{
		// 在「统计的在记」与「运行记录」之后:那两步读的是旧形状里逐条的 `"ts"`,压缩之后就没有了。把粉丝样本改成新形状、
		// 按「现在」压一遍(ADR-0027 决策 8、15;㉘c)。
		label: "粉丝样本压缩",
		run: (opts, report) =>
			migrateFollowerCompression(opts.targetDir, opts.now ?? new Date(), (reason) =>
				report.skipped.push({ path: FOLLOWERS_DIR.join("/"), reason }),
			),
	},
	{
		label: "锐评草稿",
		run: withBiliSubscriptions((opts, subscriptions) =>
			migrateRoastDraftsFile(dataPath(opts.targetDir, ...ROAST_DRAFTS_FILE), subscriptions),
		),
	},
	{
		label: "订阅资料",
		run: async (opts, report) => {
			const done = await migrateProfileAvatars({
				zeroDir: zeroPath(opts.zeroRoot, "avatars"),
				imagesDir: dataPath(opts.targetDir, "images"),
				runtimeFile: dataPath(opts.targetDir, ...SUBSCRIPTION_STATE_FILE),
			});
			// 头像的账:搬进图库的各记一条(旧路径 → 图库里的引用),没搬的按数量各记一句,不逐个列。
			for (const { file, ref } of done.copied) {
				report.transfers.push({
					from: `avatars/${file}`,
					to: portable(relative(opts.targetDir, dataPath(opts.targetDir, "images", ref))),
					method: "copy",
				});
			}
			if (done.dropped > 0) {
				report.skipped.push({
					path: "avatars",
					reason: `${done.dropped} 个拓展订阅的头像对不上(文件不在、不是图库收的图、超过 8MB 或路径不对),资料里不再带头像,等拓展下一次报资料再来`,
				});
			}
			if (done.orphans > 0) {
				report.skipped.push({
					path: "avatars",
					reason: `${done.orphans} 个头像文件没有任何资料引用,没带过来`,
				});
			}
			const subscriptions = await readBiliSubscriptionKeys(dataPath(opts.targetDir, ...CONFIG_DIR));
			const migrated = await migrateSubscriptionState({
				dataRoot: opts.targetDir,
				biliSubscriptions: subscriptions ?? [],
			});
			report.skipped.push(...migrated.skipped);
			return [...done.rewritten, ...migrated.rewritten];
		},
	},
	{ label: "界面皮肤", run: (opts) => migrateDashboardSkins(opts.targetDir) },
	{
		label: "密钥",
		run: async (opts) =>
			migrateSecretBag(
				dataPath(opts.targetDir, "secrets", "config-secrets.enc"),
				await readZeroGenerationKey(opts.zeroRoot, opts.passphrase),
			),
	},
	{
		label: "B 站登录",
		run: async (opts, report) => {
			// `secrets` 那一项的 `inputs` 无条件记了一条「没带过来」(见上):转成功了摘掉、记一条转换;没转成只改原因。
			const path = "secrets/cookies.json";
			const login = await migrateBiliLogin({
				cookiesPath: zeroPath(opts.zeroRoot, "secrets", "cookies.json"),
				targetDir: opts.targetDir,
				key: await readZeroGenerationKey(opts.zeroRoot, opts.passphrase),
			});
			if (login.kind === "written") {
				report.skipped = report.skipped.filter((skipped) => skipped.path !== path);
				report.transfers.push({ from: path, to: BILI_LOGIN_TARGET, method: "convert" });
			} else if (login.kind === "dropped") {
				report.skipped = report.skipped.map((skipped) =>
					skipped.path === path
						? { path, reason: `B 站登录没带过来(${login.reason}),需要重新扫码` }
						: skipped,
				);
			}
			return [];
		},
	},
];

/**
 * 要按 uid 找回订阅的那几步:读新代里迁好的 B 站订阅交给它。订阅文件读不懂就整步跳过 —— 配置仓开机时会拒收
 * 它,别在它上面改别的文件。
 */
function withBiliSubscriptions(
	run: (
		opts: MigrateZeroGenerationOptions,
		subscriptions: BiliSubscriptionKey[],
	) => Promise<string[]>,
): (opts: MigrateZeroGenerationOptions) => Promise<string[]> {
	return async (opts) => {
		const subscriptions = await readBiliSubscriptionKeys(dataPath(opts.targetDir, ...CONFIG_DIR));
		return subscriptions ? run(opts, subscriptions) : [];
	};
}

interface MigrationContext {
	zeroRoot: string;
	targetDir: string;
	report: ZeroMigrationResult;
}

/** 搬一棵目录时哪些东西只作输入:`root` 是这棵目录在第 0 代里的路径,`inputs` 的路径相对它。 */
interface TransferScope {
	root: string;
	inputs: (path: string) => string | undefined;
}

/** 搬一个文件或一整棵目录。目录搬完 fsync 一次,新代改名之前它的每一层都落了盘。 */
async function transfer(
	context: MigrationContext,
	from: string,
	to: string,
	scope?: TransferScope,
): Promise<void> {
	const info = await lstat(from);
	if (info.isSymbolicLink()) {
		// 开发版 devtools 链进来的拓展:重建同样的一条,指向同一个地方。相对的目标按原来的位置解开,
		// 挪到新代里不会指歪。Windows 上目录要用 junction(和 devtools 建的时候一样)。
		const target = await readlink(from);
		const absolute = isAbsolute(target) ? target : resolve(dirname(from), target);
		const isDir = (await stat(from).catch(() => undefined))?.isDirectory() ?? false;
		await mkdir(dirname(to), { recursive: true });
		await symlink(
			absolute,
			to,
			isDir ? (process.platform === "win32" ? "junction" : "dir") : "file",
		);
		context.report.transfers.push({
			from: portable(relative(context.zeroRoot, from)),
			to: portable(relative(context.targetDir, to)),
			method: "symlink",
		});
		return;
	}
	if (info.isDirectory()) {
		await mkdir(to, { recursive: true });
		/** 只作输入没搬的:一句话 → 它们的路径。 */
		const held = new Map<string, string[]>();
		for (const name of (await readdir(from)).sort()) {
			const path = join(from, name);
			const reason = leftoverReason(name);
			const input = scope?.inputs(portable(relative(scope.root, path)));
			if (reason) {
				skip(context, path, reason);
			} else if (input) {
				held.set(input, [...(held.get(input) ?? []), path]);
			} else {
				await transfer(context, path, join(to, name), scope);
			}
		}
		// 一条一条记会淹没报告:只有一个就记它自己,多了合成一条记在这一层目录上。
		for (const [reason, paths] of held) {
			const [only] = paths;
			if (paths.length === 1 && only !== undefined) skip(context, only, reason);
			else skip(context, from, `${reason}(共 ${paths.length} 个)`);
		}
		await syncDirectory(to);
		return;
	}
	if (!info.isFile()) {
		skip(context, from, "不是普通文件");
		return;
	}
	await copyFileAtomic(from, to);
	context.report.transfers.push({
		from: portable(relative(context.zeroRoot, from)),
		to: portable(relative(context.targetDir, to)),
		method: "copy",
	});
}

function skip(context: MigrationContext, path: string, reason: string): void {
	context.report.skipped.push({ path: portable(relative(context.zeroRoot, path)), reason });
}

function portable(path: string): string {
	return path.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
