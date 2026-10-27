/**
 * 系统级动作。现在只有一件:**重启服务端**。
 *
 * 重启 = 优雅停机 + 退 0,等**外面那位**把它拉起来(与应用更新走的是同一条路)。所以
 * 「能不能重启」问的其实是「外面有没有那位」—— 面板据此决定给不给按钮。给了却没人拉,
 * 用户按下去就是把 BN 关了,而界面上只会显示连不上。
 *
 * ⛔ **不做成一颗常驻按钮**:重启是某个动作的后果,只在确实需要它的那件事旁边就地提示。
 * 所以这份判据**跟着那件事走**:装完拓展的回话,以及拓展列表(ADR-0012 决策 47 —— 只在某个
 * 拓展有新版等着换上时才被读,那颗钮也只在那时出现)。
 */

/** 谁把退出的服务端拉起来 —— 答案决定了按钮出不出,以及旁边那句话怎么写。 */
export type RestartAbility =
	| {
			can: true;
			/**
			 * - `desktop` —— 桌面外壳:它盯着 sidecar,见退出码 0 就重新拉起,一定回得来。
			 * - `container` —— 容器的 `restart:` 策略。**没配的话没人拉**,所以文案要提这一句。
			 */
			how: "desktop" | "container";
	  }
	| {
			can: false;
			/**
			 * 「能不能」的预检保留 `can`,原因用 `code` + `message`(ADR-0026 决策 2):
			 * - `source_run` —— tsx 直跑的开发版:`tsx watch` 只在文件变了才重来,自己退了就是退了。
			 * - `unsupervised` —— 直接 `node lib/index.mjs`:退了没人管。
			 */
			code: "source_run" | "unsupervised";
			/** 拉不起来时那句话,服务端按当前语言给。两种的出路不一样,所以面板原样显示它、不另写一份。 */
			message: string;
	  };

/** `POST /api/system/restart` 的回话。**先回话再关自己**,否则用户看到的是网络错误。 */
export interface RestartResponse {
	restarting: true;
	/** 要换掉的那个进程的启动时刻(与 `/api/health` 同一个值)—— 它变了才算真的重启完。 */
	startedAt: string;
	/** 现在跑的版本。重启后 `boot.mjs` 会重新选版,面板拿它当「该回到哪一版」的期望。 */
	version: string;
}

/**
 * 开新代的来源(ADR-0022 决策 3 下 10-01 的 🔗):`empty` 是全新开始(空的一代,回新手引导),`zero` 是从
 * 第 0 代(0.x 留下的数据)重新迁移。两样都开下一个号的新代,当前那一代原地留着当备份。
 */
export type GenerationSourceKind = "empty" | "zero";

/** `POST /api/system/generations` 的请求体:要开哪种新代。回话是 {@link RestartResponse} —— 开代在重启后的开机里做。 */
export interface GenerationCreateRequest {
	source: GenerationSourceKind;
}

/**
 * 一个版本的更新说明（从 `apps/CHANGELOG.md` 打包进载荷）。
 *
 * ⚠️ `summary` 与 `caution` 都是 **markdown 原文**，面板用受限的文档渲染画；更新清单里「有新版」通知卡的
 * `notes` 才是剥掉 markdown 的纯文字，两者别混。`caution` 是 CHANGELOG 里以 ⚠️ 开头、要主人动手的那一段。
 */
export interface ReleaseNoteEntry {
	version: string;
	/** 发布日期（`YYYY-MM-DD`），CHANGELOG 标题没写就缺。 */
	date?: string;
	summary: string;
	caution?: string;
	/** 这一版的 GitHub Release 页，完整更新说明在那里。 */
	releaseUrl: string;
}

interface SystemNoticeBase {
	id: string;
	createdAt: string;
}

/**
 * 开机之后要告诉主人的一件事。面板只拉一张清单(`GET /api/system/notices`)、按 `kind` 画;以后多一种
 * 提示,往这个联合里加一种。主人看过就标已读(`POST /api/system/notices/:id/acknowledge`),之后不再出现。
 *
 * - `migrated` —— 这一代是从 0.x 的数据迁来的:旧数据原样留着当备份;`cardSkinsDropped` 说老卡片皮肤
 *   没迁(ADR-0022 决策 12),要重新做;`masterTargetCleared` 说原来的主人目标不是私聊(群,或目标已不在),
 *   迁移替主人清空了,要到系统页重新选一个(ADR-0021 决策 57)。
 * - `generation-failed` —— 主人要求开的新代没开成,还在用原来那一代;`message` 是失败原因原话。
 * - `rolled-back` —— `version` 起不来,被启动器判死、退回了现在这一版。只报比正在跑的版本新的。
 * - `updated` —— 升级之后的「本次更新」:正在跑的版本 `version` 比这一代跑过的最高版本新。`releases` 是跨过的各版
 *   说明,新的在前,同号的正式版盖掉它自己的预发布段。没看过又升了一版时合成一条,范围从旧那条没看过的起点算起。
 *   开发版不记。
 * - `migrated` 另带 `version`(开出这一代的版本)与 `releases`(1.0 起到它为止的各版说明),首访页顶上的更新总结用。
 *   说明是服务端在读清单那一刻从载荷里的数据文件现补的,盘上不存。
 */
export type SystemNotice =
	| (SystemNoticeBase & {
			kind: "migrated";
			cardSkinsDropped: boolean;
			masterTargetCleared: boolean;
			version: string;
			releases: ReleaseNoteEntry[];
	  })
	| (SystemNoticeBase & { kind: "updated"; version: string; releases: ReleaseNoteEntry[] })
	| (SystemNoticeBase & {
			kind: "generation-failed";
			source: GenerationSourceKind;
			message: string;
	  })
	| (SystemNoticeBase & { kind: "rolled-back"; version: string });

/** `GET /api/system/notices` 的回话:主人还没看过的那些,先来的在前。 */
export interface SystemNoticesResponse {
	notices: SystemNotice[];
}

/**
 * 一代为什么不许删(服务端判,面板据此出文案;规则见 ADR-0022 决策 7 与 2026-10-06 的 🔗):
 *
 * - `current` —— 正在用的这一代,永远不许删;
 * - `partial` —— 写到一半的(`<序号>.partial/`),要么还在写、要么等开机清掉;
 * - `unreadable` —— `generation.json` 读不懂。它可能是更新版本的程序写的,拿不准就不删;
 *   真损坏的代只能手动清盘;
 * - `newer-format` —— 格式版本比这一版认得的新:那是更新版本的数据;
 * - `protected-source` / `protected-previous` —— 当前代的来源代 / 上一代,要等当前代满 30 天,
 *   到期时刻见 {@link GenerationInfo.deletableAt};两者同时算时报 `protected-source`;
 * - `current-age-unknown` —— 当前代自己的创建时间读不到,没法算满没满,一律当作没满、全部锁住。
 */
export type GenerationLockReason =
	| "current"
	| "partial"
	| "unreadable"
	| "newer-format"
	| "protected-source"
	| "protected-previous"
	| "current-age-unknown";

/** `GET /api/system/generations` 里的一代。第 0 代(0.x 留在宿主根上的数据)序号是 0。 */
export interface GenerationInfo {
	seq: number;
	current: boolean;
	/** 写到一半的(`<序号>.partial/`);同一个序号可以同时有一份完整的和一份写到一半的。 */
	partial: boolean;
	/** 数据格式版本。第 0 代、写到一半的、读不懂的没有。 */
	formatVersion: number | null;
	/** 是哪个版本的程序建的。第 0 代是 `"0.x"`;写到一半的、读不懂的没有。 */
	createdBy: string | null;
	/** 最后一次开机用到它的时刻(ISO)。第 0 代没有这个记录,也不拿文件修改时间顶替。 */
	lastActiveAt: string | null;
	/** 现在能不能删。服务端判,`DELETE` 同一套判断。 */
	deletable: boolean;
	/** 不能删的原因;能删是 `null`。 */
	lockReason: GenerationLockReason | null;
	/** 受 30 天保护的给出到期时刻(ISO,= 当前代创建时刻 + 30 天);已到期或不受时间保护的是 `null`。 */
	deletableAt: string | null;
	/** 目录看上去多大(全树文件大小之和,不跟符号链接)。硬链接的文件在别的代还活着,所以会高估删了能腾的。 */
	sizeBytes: number;
	/** 删掉真能腾出多少的**下界**:只数硬链接数为 1 的文件。 */
	reclaimableBytes: number;
}

/** `GET /api/system/generations` 的回话:第 0 代(存在才列)与 `generations/` 下的每一代,序号小的在前。 */
export interface GenerationsResponse {
	generations: GenerationInfo[];
}

/**
 * `DELETE /api/system/generations/:seq` 的回话。删除**不可恢复**。
 * 不能删是 409 `conflict`(只带人话;原因码读列表里的 {@link GenerationInfo.lockReason});序号不是纯数字是 400,
 * 没有这一代是 404(与别的 `DELETE` 同口径,不做幂等)。
 */
export interface GenerationDeleteResponse {
	/** 腾出的字节数:删之前量的 {@link GenerationInfo.reclaimableBytes}(下界)。 */
	freedBytes: number;
}

/**
 * 「存储占用」里的类别(ADR-0027 决策 10 / 17;㉙d)。
 *
 * - 可清的四类:`stats`(数据统计:作品、直播、「在记」小账、粉丝样本)、`historyText`(推送历史的文字)、
 *   `historyImages`(推送历史的图 + 重推原件)、`ai`(女仆对话与只被对话引用的图);
 * - 只读的两行:`logs`(日志,按天数滚动)、`otherImages`(图库里不属于上面两个图类的全部:订阅头像、作品配图、
 *   拓展直播的图、没人引用的、同时被两类引用的);
 * - `generations`(旧版本数据):不走整类清空,面板去调 `/api/system/generations` 逐代删。
 */
export type StorageCategory =
	| "stats"
	| "historyText"
	| "historyImages"
	| "ai"
	| "logs"
	| "otherImages"
	| "generations";

/** 能用 `DELETE /api/system/storage/:category` 整类清空的那几类。 */
export type ClearableStorageCategory = Extract<
	StorageCategory,
	"stats" | "historyText" | "historyImages" | "ai"
>;

/** `GET /api/system/storage` 里的一行。 */
export interface StorageUsageRow {
	category: StorageCategory;
	/**
	 * 这一类占了多少字节(全树文件大小之和,不跟符号链接)。`generations` 一行是各个**可删的**旧代的
	 * `reclaimableBytes` 之和(删掉真能腾出的下界),不是目录看上去的大小。
	 */
	sizeBytes: number;
	/** 能不能用整类清空的口清。只读的两行与 `generations` 是 `false`。 */
	clearable: boolean;
	/** 只有 `generations` 这一行带:现在能删的旧代有几代(逐代删去 `/api/system/generations`)。 */
	deletableGenerations?: number;
}

/** `GET /api/system/storage` 的回话:每个类别一行,次序固定。量大小要遍历目录与图库,可能慢(秒级),不缓存。 */
export interface StorageUsageResponse {
	rows: StorageUsageRow[];
}

/**
 * `DELETE /api/system/storage/:category` 的回话。整类清空**不可恢复**;已经空了回成功、0(幂等);
 * 不是四个可清类别之一(未知键、只读的两行、`generations`)是 400。
 *
 * `historyText` 清的是推送历史的日文件**连同重推原件**(行没了,原件没有入口能读到;原件引用的图随之由清扫收走),
 * 图的保留水位线不动。
 */
export interface StorageClearResponse {
	/**
	 * **实际**腾出的字节数:文件按清理前后各量一次的差,图按这一次图库清扫真删掉的字节。图库清扫只删没人引用
	 * **且存进来超过 24 小时**的图,所以清完立刻腾出的可能比用量表上那一行少 —— 这里回的是已经发生的,不是预计。
	 */
	freedBytes: number;
}

/**
 * `POST /api/system/storage/images/sweep` 的回话:手动触发一次图库清扫的结果。它**不绕过**宽限期
 * (刚存进来 24 小时内的图不删),价值只是不用等定时的那一轮。
 */
export interface ImageSweepResponse {
	/** 这一次删掉几张图。 */
	removedCount: number;
	/** 删掉的图一共多少字节。 */
	removedBytes: number;
	/** 过了宽限期、因为还有人引用而留下的张数。 */
	referenced: number;
	/** 还在宽限期里的张数。 */
	inGrace: number;
}
