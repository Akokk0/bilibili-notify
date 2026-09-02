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
	/** 清单拿到了,包没下下来。 */
	| "download-failed"
	/** 包下下来了,但不是清单说的那一坨字节。 */
	| "checksum-mismatch"
	/** 包是对的,写进版本目录时失败(磁盘满 / 只读 / 包里有越界路径)。 */
	| "install-failed"
	/** 已经在最底下那一版上了,没得退。 */
	| "nothing-to-roll-back";

export type UpdateState =
	/** 这个构建没内置任何信任公钥 —— 功能是**关的**,不是「验签失败」。 */
	| { phase: "disabled" }
	/** 还没查过。 */
	| { phase: "idle" }
	| { phase: "up-to-date"; checkedAt: number }
	/** 有新版但还没下(关掉了自动下载)。 */
	| { phase: "available"; target: string; releaseUrl: string; notes?: string; checkedAt: number }
	| { phase: "downloading"; target: string; releaseUrl: string; notes?: string }
	/** 已经装进版本目录,**重启就会跑它**。 */
	| { phase: "ready"; target: string; releaseUrl: string; notes?: string }
	/** 这一版要更新的镜像才跑得动,在线升不上去 —— Node / chromium 都来自镜像。 */
	| { phase: "needs-image-pull"; target: string; releaseUrl: string; checkedAt: number }
	/** 钉子已落,重启就会回到上一版。 */
	| { phase: "rolled-back"; target: string }
	/** `helpUrl` 是「下不动就给个链接让用户自己去下」那条兜底出口。 */
	| { phase: "error"; reason: UpdateErrorReason; helpUrl?: string; checkedAt: number };

export interface UpdateStatusDTO {
	/** 当前正在跑的那份载荷的版本。 */
	currentVersion: string;
	/** 退一步会退到哪。`null` = 已经在最底下那版,回退按钮该是灰的。 */
	rollbackTarget: string | null;
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
	| { prefix: string; ok: false; ms: number; reason: "unreachable" | "untrusted" | "malformed" };

export interface MirrorProbeResponse {
	results: MirrorProbeResult[];
}
