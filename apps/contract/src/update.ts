/**
 * 自主升级的 wire 契约 —— `GET /api/update` 的响应,以及它的几个动作。
 *
 * 状态是个**判别联合**而不是一把布尔标志(`hasUpdate` / `downloading` / `failed`
 * …):后者能拼出「既在下载又已失败」这种谁也没想过的组合,而界面必须为每一种组合
 * 挑一个说法。联合体让「现在是哪一档」只有一个答案。
 */

/**
 * 升不上去的原因。**分得这么细是有代价的,但混成一句「更新失败」的代价更大** ——
 * 代理站抽风会被当成安全事件去查,而真的有人在中间改包会被当成小毛病忽略。
 */
export type UpdateErrorReason =
	/** 每个候选站都试过了,一个都没拿到。多半是网络 / 加速前缀填错。 */
	| "unreachable"
	/** 签名验不过 —— 分发链上可能有人动过手脚。**只有这一条该弹红字。** */
	| "untrusted"
	/** 签名没问题,但内容不是一份合法清单 —— 是**我们自己**发错了东西。 */
	| "malformed"
	/**
	 * 签名没问题,但比之前见过的清单**旧**。多半是加速站缓存了旧文件(换个站或直连);
	 * 也可能是有人在回放一份被撤回版本的清单 —— 两种都不该收。
	 */
	| "stale-manifest"
	/** 清单拿到了,包没下下来。 */
	| "download-failed"
	/** 包下下来了,但不是清单说的那一坨字节。 */
	| "checksum-mismatch"
	/** 包是对的,写进版本目录时失败(磁盘满 / 只读 / 包里有越界路径)。 */
	| "install-failed"
	/** 已经在最底下那一版上了,没得退。 */
	| "nothing-to-roll-back";

export type UpdateState =
	/**
	 * 功能是**关的**,不是「验签失败」。两种理由:`no-keys` = 这个构建没内置任何信任公钥
	 * (自己 fork 出去构建的);`dev-build` = 正在跑的是源码里的占位版本(`0.0.0-dev`,
	 * 或读不到 package.json 时的兜底 `dev`),它比任何发出去的版本都小,不挡的话开发时
	 * 每次开面板都被提示「有新版」。
	 */
	| { phase: "disabled"; reason: "no-keys" | "dev-build" }
	/** 还没查过。 */
	| { phase: "idle" }
	| { phase: "up-to-date"; checkedAt: number }
	/** 有新版但还没下(关掉了自动下载)。 */
	| { phase: "available"; target: string; releaseUrl: string; notes?: string; checkedAt: number }
	| { phase: "downloading"; target: string; releaseUrl: string; notes?: string }
	/** 已经装进版本目录,**重启就会跑它**。 */
	| { phase: "ready"; target: string; releaseUrl: string; notes?: string }
	/**
	 * 这一版要更新的镜像才跑得动,在线升不上去 —— Node / chromium 都来自镜像。`notes` 照带:
	 * 换不了也得让人知道它是什么,右下角那张卡念的就是它。
	 */
	| {
			phase: "needs-image-pull";
			target: string;
			releaseUrl: string;
			notes?: string;
			checkedAt: number;
	  }
	/** 钉子已落,重启就会回到上一版。 */
	| { phase: "rolled-back"; target: string }
	/** `helpUrl` 是「下不动就给个链接让用户自己去下」那条兜底出口。 */
	| { phase: "error"; reason: UpdateErrorReason; helpUrl?: string; checkedAt: number };

/**
 * 这一档按「立即重启并应用」有没有意义。
 *
 * 只有两档有:装好了等着跑,或者钉子已落等着退回去。别的状态下重启只会让用户看到
 * 「版本没变」—— 而重启本身有代价(推送会断、直播监听会掉)。
 *
 * 住在契约里是因为**服务端与面板必须同时点头**:服务端据它回 409,面板据它决定按钮
 * 出不出。各写一份字面量的话,漏改一边的症状是按钮点下去报错、或者一个本该能应用的
 * 状态上按钮凭空消失,而两种都不会有任何东西报警。
 */
export function canApplyUpdate(state: UpdateState): state is ApplicableUpdateState {
	return state.phase === "ready" || state.phase === "rolled-back";
}

/** 能应用的两档 —— 都带着 `target`,重启后该跑的就是它。 */
export type ApplicableUpdateState = Extract<UpdateState, { phase: "ready" | "rolled-back" }>;

/**
 * `POST /api/update/apply` 的回话:话说完就关自己。面板据它等新进程 —— 之后只认
 * `startedAt` 和这里不同的 `/api/health` 回答;`target` / `mode` 由服务端说,它正握着
 * 状态,面板不必先探一次、再从状态里猜。
 */
export interface UpdateApplyResponse {
	restarting: true;
	/** 被换掉的这个进程的启动时刻(ISO),与 `/api/health` 的 `startedAt` 同源。 */
	startedAt: string;
	/** 重启后应当跑起来的版本。 */
	target: string;
	/** 升上去还是退回去 —— 刷新后那句「已更新到 / 已退回」据此说。 */
	mode: "update" | "rollback";
}

export interface UpdateStatusDTO {
	/** 当前正在跑的那份载荷的版本。 */
	currentVersion: string;
	/** 退一步会退到哪。`null` = 已经在最底下那版,回退按钮该是灰的。 */
	rollbackTarget: string | null;
	/**
	 * 盘上钉着的版本(回退落下的钉子),`null` = 没钉。
	 *
	 * 和 `state` 里的 `rolled-back` 不是一回事:那个是**内存态**,只活到重启;而回退
	 * 恰恰靠重启生效 —— 重启之后 `state` 是 `idle`,钉子却还在盘上。面板「打开就查一次」
	 * 看的是这一项:钉着就不自动查,否则自动检查会装新版、顺手拔钉子,用户按的回退
	 * 活不过一次开面板。手动「检查更新」不受它限制,那是明确要往前走。
	 */
	pinnedVersion: string | null;
	state: UpdateState;
}

/**
 * 内置的下载加速站候选(前缀形式,拼在 GitHub Release 地址前面)。
 *
 * **只是候选,不是默认。** 默认直连;用户在面板里「测一遍」、选一个用。这份名单决定的是
 * 「面板上给谁看」,不是「默认和谁说话」—— 后者见 internal 的 `UpdateSettingsSchema`
 * 那条记录在案的决定。哪个站死了,面板里一测就露馅,不必靠发版来收回。
 *
 * 名单是 2026-09-02 凭经验列的,没有逐个实测(主人拍板:不测,直接写)。
 */
export const BUILTIN_UPDATE_MIRRORS: readonly string[] = [
	"https://ghfast.top/",
	"https://gh-proxy.com/",
	"https://ghproxy.net/",
	"https://hub.gitmirror.com/",
	"https://gh.llkk.cc/",
	"https://git.yylx.win/",
];

/**
 * 一条加速前缀长得合不合法。空串(直连)不走这里,由调用方各自判。
 *
 * 服务端拿它守 `POST /api/update/mirrors/probe`(这是一个让服务端去连任意主机的入口),
 * 面板拿它决定自定义那一格能不能选,而落盘那道门(internal 的 `UpdateSettingsSchema`)
 * 才是最终说了算的那个。三处判得不一样的话,用户会遇到「测得通、存不进去」—— 所以
 * 本体只有一份,住在 internal 零依赖的 constants 里(schema 也用同一条正则),这里只是
 * 转出去。
 */
export { isMirrorPrefix } from "@bilibili-notify/internal/constants";

/** `POST /api/update/mirrors/probe` 的请求体。`prefixes` 里的空串 = 直连。 */
export interface MirrorProbeRequest {
	prefixes: string[];
}

/**
 * 一个候选站测出来的结果:通就给毫秒数和**通过它拿到的清单版本**(某个站缓存了旧
 * 清单一眼看得出);不通就按老规矩归因 —— 连不上、签名验不过、清单不成形,三件事。
 */
export type MirrorProbeResult =
	| { prefix: string; ok: true; ms: number; version: string }
	| {
			prefix: string;
			ok: false;
			ms: number;
			/** `stale`:这个站给的清单比之前见过的旧 —— 它缓存了旧文件。 */
			reason: "unreachable" | "untrusted" | "malformed" | "stale";
	  };

export interface MirrorProbeResponse {
	results: MirrorProbeResult[];
}
