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
			 * - `source-run` —— tsx 直跑的开发版:`tsx watch` 只在文件变了才重来,自己退了就是退了。
			 * - `unsupervised` —— 直接 `node lib/index.mjs`:退了没人管。
			 */
			reason: "source-run" | "unsupervised";
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

interface SystemNoticeBase {
	id: string;
	createdAt: string;
}

/**
 * 开机之后要告诉主人的一件事。面板只拉一张清单(`GET /api/system/notices`)、按 `kind` 画;以后多一种
 * 提示,往这个联合里加一种。主人看过就标已读(`POST /api/system/notices/:id/acknowledge`),之后不再出现。
 *
 * - `migrated` —— 这一代是从 0.x 的数据迁来的:旧数据原样留着当备份;`cardSkinsDropped` 说老卡片皮肤
 *   没迁(ADR-0022 决策 12),要重新做。
 * - `generation-failed` —— 主人要求开的新代没开成,还在用原来那一代;`message` 是失败原因原话。
 * - `rolled-back` —— `version` 起不来,被启动器判死、退回了现在这一版。只报比正在跑的版本新的。
 */
export type SystemNotice =
	| (SystemNoticeBase & { kind: "migrated"; cardSkinsDropped: boolean })
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
