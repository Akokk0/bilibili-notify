import type {
	Connection,
	GlobalSettings,
	PushTarget,
	Subscription,
	SubscriptionTag,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import type { EncryptedSecrets } from "./crypto.js";
import { BackupRejectedError } from "./rejected-error.js";

/**
 * Backup envelope — the single-file, self-describing container for the
 * "一键备份 / 恢复" feature.
 *
 * A backup is one JSON document with a stable {@link BACKUP_FORMAT} marker and
 * a {@link BACKUP_SCHEMA_VERSION}. Two kinds:
 *   - `sanitized` — non-secret business config only (subscriptions/targets/…),
 *     safe to share / commit to git. No `secrets` block.
 *   - `full` — the same plaintext sections PLUS a PIN-encrypted `secrets` block
 *     (cookie / apiKey / bot tokens). See the `secrets` slice for that shape.
 *
 * `sections` carries the platform-neutral config scopes verbatim (the same
 * shapes `ConfigStore` reads/writes). Secret-bearing residue (apiKey, connection
 * credentials) is stripped from these plaintext sections and, for `full`
 * backups, re-homed into the encrypted block — never left in the clear here.
 */

export const BACKUP_FORMAT = "bilibili-notify-backup" as const;
/**
 * 23 = 联网搜索开关改为 `ai.search.scenes.{post,live,roast}` 以后导出的备份；旧 `engines.dynamic` 不再由现代schema读取。
 * 22 = 文字模板只存改过的以后导出的备份(设置 `defaults.templates` 里没改过的文字格不在,读时按当前语言取出厂;
 * 老备份里整份存着的默认原文会被当成「主人改过的」,不再跟语言,所以整份拒收)；内置人格也只记删了哪几份
 * (`ai.removedBuiltinPresets`,缺 = 一份没删;`ai.presets` 只装主人自己的,顶层 `persona` / 两段提示词不再有,
 * 老备份里整份存着的四份内置会和内置列表撞 id,同样整份拒收)。
 * 21 = 链接预览的回复形式多了 `text` 以后导出的备份(默认行与逐目标例外的 `replyForm` 都可能是 `text`)。
 * 20 = 直播文案占位符改名以后导出的备份(特别弹幕 / 特别进场的文案用 `{name}` / `{viewer}`,弹幕总结用 `{fanclub}`;
 * 直播的六条文案里没有 `-key` 老写法)。
 * 19 = 链接设置改成五格以后导出的备份(设置里 `linkParsing` 成了 `linkPreview`:`enabled`、`isOnByDefault`、`replyForm`、
 * `byTarget`、`cooldownSec`,回复形式 `miniapp` 叫 `nativeShare`;AI 写正文 `ai.writing.post` / `liveSummary` 的默认行
 * `enabled` 叫 `isOnByDefault`)。
 * 18 = 特别关注名单与两把特性键改形状以后导出的备份(订阅的 `specialUsers { uid, kinds, template? }` 成了
 * `specialViewers { id, note?, features }`;特性键 `specialDanmaku` / `specialUserEnter` 叫 `viewerChat` / `viewerEnter`:
 * 设置与订阅里的开关、路由、文案键,默认文案账本,历史行的 `feature`)。
 * 17 = AI 设置上提以后导出的备份(设置里 AI 整段从 `defaults.ai` 成了顶层的 `ai`,里面的键不动)。
 * 16 = 默认文案账本上提以后导出的备份(设置里账本从 `defaults.templateDefaultsSeen` 成了顶层的 `templatesSeen`)。
 * 15 = 核心设置拆掉 `app` 以后导出的备份(设置里日志的四格进了 `logging`:`level` / `levels` / `retentionDays` /
 * `memoryLog.enabled`,日志等级表里 `dynamic` / `live` 并成了 `bilibili`;粉丝轮询的 cron 成了顶层 `profileRefreshCron`)。
 * 14 = 密钥袋按集成分格以后导出的备份(完整档的密钥袋里,B 站登录不再是平铺的 cookiesJson / refreshToken 两格,改成
 * integrationSecrets:集成键 → 这个集成的 secrets 整袋;恢复结果里 cookiesRestored 换成 restoredIntegrations /
 * unrestoredIntegrations)。
 * 13 =连接换成新形状以后导出的备份(连接是 `{ id, name, enabled, adapterKey, platform, settings, platformSnapshot,
 * probeState? }`:`kind` / `connector` / `extensionId` 没有了,`config` 叫 `settings`,多了平台快照与探测状态;OneBot 的
 * `retryTimes` 叫 `maxRetries`;连接的探测状态 `testStatus` 叫 `probeState`、目标的叫 `reachability`)。连接的 `settings`
 * 在脱敏档与完整档的明文段里按在场适配器的规则抹,适配器不在场或设置不合法的整片抹空。
 * 12 = 推送目标不再带 `platform` 以后导出的备份(平台只在连接上;端点目标也没有 `scope`;恢复时,本机已有的目标要是
 * 换了连接、或它挂着的连接换了种类 / 平台,整份拒收)。
 * 11 = 主人目标只许指向私聊目标以后导出的备份(设置 `master.targetId` 指向的推送目标必须存在、而且是私聊会话;
 * 恢复时不满足的整份拒收)。
 * 10 = 合并转发的设置键改名以后导出的备份(设置 `defaults.imageGroup` 与订阅 `overrides.imageGroup` 里,`enable` / `forward` 叫
 * `enabled` / `mergeForward`;OneBot 连接的 `config.forwardMinTimeoutMs` 叫 `mergeForwardMinTimeoutMs`)。
 * 9 = 卡片设置搬家以后导出的备份(设置 `defaults.cardStyle` / `cardStyleByKind` 并成了 `defaults.cards = { enabled, liveCoverImageIds }`,
 * 订阅的 `overrides.cardStyle` / `cardStyleByKind` 并成了 `overrides.cards = { liveCoverImageIds? }`;退役的字体 / 玻璃字段没有了;
 * 卡种键改叫 `live` / `post` / `superchat` / `membership` / `roastBoard` / `roastSolo` / `wordcloud`;卡片皮肤包的格式版本是 2,
 * 皮肤包里不再有 `variables` / `variablesByKind`)。
 * 8 = 会员与醒目留言的设置搬家以后导出的备份(两个直播门槛搬出了 `filters`:`filters.minScPrice` 成了 `defaults.superchat.minAmount`,
 * `filters.minGuardLevel` 成了 `defaults.membership.minRank.guard`(rank 与旧等级倒过来),订阅的 `overrides` 里同样各多一段;
 * 上舰文案 `templates.guardBuy` 成了 `templates.membership.guard = { enabled, default, tiers }`,占位符叫 `{viewer}` / `{name}` /
 * `{tier}`;默认文案账本里上舰那几条换成 `membership.guard.default.template` / `.imageUrl`)。
 * 7 = 过滤键改名以后导出的备份(设置 `defaults.filters` 与订阅 `overrides.filters` 里,`blockForward` / `blockArticle` / `blockDraw` /
 * `blockAv` 叫 `blockReposts` / `blockArticles` / `blockImages` / `blockVideos`,`whitelistKeywords` / `whitelistRegex` 叫
 * `allowKeywords` / `allowRegex`;其余过滤键不变)。
 * 6 = 历史保留换键以后导出的备份(设置里顶层多一节 `history`,`history.retentionDays` 只许七档;`app.historyRetentionDays`
 * 没有了)。
 * 5 = 直播拆键以后导出的备份(新特性 `liveStreaming`:订阅的 `routing` / `overrides.features` 与设置的 `defaults.features`
 * 里多一把键,`routing.liveStreaming` 是开播目标的拷贝;周期间隔 `schedule.pushTime` 与启动补报 `schedule.restartPush`
 * 拆成 `liveStreaming.streamingIntervalHours` 与 `liveStart.catchUpOnBoot`,订阅覆盖里同理;文案 `templates.liveOngoing` 叫
 * `liveStreaming`)。
 * 4 = 特性键改名以后导出的备份(订阅的 `routing` / `overrides` 与设置的 `defaults` 里,特性键、附加项键、文案键、版式键换成
 * 1.0 的名字:`post` / `liveStart` / `membership`、`atAllPost` / `atAllLiveStart`、`templates.post` / `postVideo`、
 * `messageLayout.post`;订阅的逐目标表叫 `extraTargets`)。
 * 10、9、8、7、6、5、4 与 3(设置按集成分文件以后,各集成的设置单独一节 `integrations`)、2 都只在开发期用过、没发布。
 * 1.0 之前(0.x 导出的 1)与开发期的旧版本一律拒收(ADR-0022 决策 6):要恢复就先装 0.12 恢复,再升级到 1.0 走迁移 ——
 * 0.x 的形状只有迁移器认得。
 */
export const BACKUP_SCHEMA_VERSION = 23 as const;

/** 0.x 导出的备份的格式版本(0.12 最后一版也是它)。拒收时只有它配得上「先装 0.12 恢复再升级」那句话。 */
const ZERO_BACKUP_SCHEMA_VERSION = 1;

export type BackupKind = "full" | "sanitized";

/** Non-secret config payload carried in plaintext in every backup. */
export interface BackupSections {
	globals?: GlobalSettings;
	/** 各集成的设置(今天只有 B 站),按集成的键;与 `globals` 同一个勾选(「设置」)。 */
	integrations?: Record<string, unknown>;
	/**
	 * 各拓展的设置,按拓展 id(盘上 `config/settings/extensions/<id>.json`);同一个勾选。开关不在这儿,在
	 * `globals.extensions`。脱敏照拓展各自声明的密钥键(`sanitize.ts`)。
	 */
	extensionSettings?: Record<string, unknown>;
	/** 订阅:B 站与拓展同一节,行行带 `identity`(ADR-0021 决策 15)。 */
	subscriptions?: Subscription[];
	/** 订阅标签表(ADR-0034):跟订阅同一个勾选、同进同出;订阅上挂的 `tagIds` 指的就是它。 */
	subscriptionTags?: SubscriptionTag[];
	connections?: Connection[];
	targets?: PushTarget[];
}

export interface BackupEnvelope {
	format: typeof BACKUP_FORMAT;
	schemaVersion: number;
	kind: BackupKind;
	/** ISO-8601 timestamp, supplied by the caller (keeps builders pure/testable). */
	createdAt: string;
	sections: BackupSections;
	/** PIN-encrypted credential block. Present only in `kind:"full"` backups. */
	secrets?: EncryptedSecrets;
}

export interface BuildBackupOptions {
	kind: BackupKind;
	createdAt: string;
	sections: BackupSections;
	secrets?: EncryptedSecrets;
}

/** Assemble a backup envelope from already-prepared sections. Pure. */
export function buildBackup(input: BuildBackupOptions): BackupEnvelope {
	const env: BackupEnvelope = {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		kind: input.kind,
		createdAt: input.createdAt,
		sections: input.sections,
	};
	if (input.secrets) env.secrets = input.secrets;
	return env;
}

/**
 * Validate an already-parsed backup object — the import trust boundary. Throws
 * a {@link BackupRejectedError} (自带码、message 是给人看的中文)on anything that is
 * not a well-formed, this-build-understands-it envelope:
 *   - wrong/absent `format` marker → not our file
 *   - unknown `kind`
 *   - `schemaVersion` newer than {@link BACKUP_SCHEMA_VERSION} → refuse (a newer
 *     export may carry fields/semantics this build cannot safely apply; never
 *     silently down-migrate).
 *   - `schemaVersion` older → refuse too: a pre-1.0 backup carries 0.x shapes
 *     only the migrator understands (ADR-0022 决策 6).
 *
 * Use this on the JSON body of an import request (already parsed by the HTTP
 * layer); {@link parseBackup} is the string convenience wrapper.
 */
export function validateBackup(raw: unknown): BackupEnvelope {
	const o = (raw ?? {}) as Partial<BackupEnvelope>;
	if (o.format !== BACKUP_FORMAT) {
		throw new BackupRejectedError("invalid", t("backup.envelope.invalidFormat"));
	}
	if (o.kind !== "full" && o.kind !== "sanitized") {
		throw new BackupRejectedError("invalid", t("backup.envelope.invalidKind"));
	}
	if (typeof o.schemaVersion !== "number") {
		throw new BackupRejectedError("invalid", t("backup.envelope.missingVersion"));
	}
	if (o.schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw new BackupRejectedError(
			"unsupported",
			t("backup.envelope.newerVersion", {
				version: o.schemaVersion,
				current: BACKUP_SCHEMA_VERSION,
			}),
		);
	}
	if (o.schemaVersion <= ZERO_BACKUP_SCHEMA_VERSION) {
		throw new BackupRejectedError("unsupported", t("backup.envelope.zeroVersion"));
	}
	// 比当前旧、又不是 0.x 导出的(开发期的版本,或以后抬了版本以后的旧备份):装 0.12 救不了它,别指那条路。
	if (o.schemaVersion < BACKUP_SCHEMA_VERSION) {
		throw new BackupRejectedError(
			"unsupported",
			t("backup.envelope.olderVersion", {
				version: o.schemaVersion,
				current: BACKUP_SCHEMA_VERSION,
			}),
		);
	}
	return o as BackupEnvelope;
}

/** Parse a backup document from JSON text, then {@link validateBackup} it. */
export function parseBackup(json: string): BackupEnvelope {
	return validateBackup(JSON.parse(json));
}
