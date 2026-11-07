import type { UpdateFailureCode, UpdateState } from "@bilibili-notify/contract";
import { ok } from "@bilibili-notify/internal";
import { RELEASES_PAGE_URL, releaseUrlOf } from "../../update/trusted-keys.js";
import type { DevScenarioDef } from "../registry.js";
import type { InjectableUpdateService } from "../update-injection.js";

/**
 * B1:更新状态 —— 9 相 8 归因,面板上每一种措辞都能一键造出来看。
 *
 * 只造 `state`,现实里的版本 / 回退目标 / 钉子照实报(见 `injectableUpdateService`)。
 * 注入 `ready` / `rolled-back` 之后「立即重启并应用」会**真的**退 0 —— 那正是要验的链路,
 * 说明里写明。
 */

const PHASES: ReadonlyArray<{ value: UpdateState["phase"]; label: string }> = [
	{ value: "disabled", label: "disabled · 功能关着" },
	{ value: "idle", label: "idle · 还没查过" },
	{ value: "up-to-date", label: "up-to-date · 已是最新" },
	{ value: "available", label: "available · 有新版没下" },
	{ value: "downloading", label: "downloading · 正在下载" },
	{ value: "ready", label: "ready · 已就绪等重启" },
	{ value: "needs-image-pull", label: "needs-image-pull · 要重拉镜像" },
	{ value: "rolled-back", label: "rolled-back · 已排队回退" },
	{ value: "error", label: "error · 升不上去" },
];

const FAILURE_CODES: ReadonlyArray<{ value: UpdateFailureCode; label: string }> = [
	{ value: "unreachable", label: "unreachable · 连不上" },
	{ value: "untrusted", label: "untrusted · 验签失败(红字)" },
	{ value: "malformed", label: "malformed · 清单不成形" },
	{ value: "stale_manifest", label: "stale_manifest · 清单比见过的旧" },
	{ value: "download_failed", label: "download_failed · 包没下下来" },
	{ value: "checksum_mismatch", label: "checksum_mismatch · 摘要对不上" },
	{ value: "install_failed", label: "install_failed · 写盘失败" },
	{ value: "nothing_to_roll_back", label: "nothing_to_roll_back · 没得退" },
];

/** `notes` 是可选字段:空串不带 —— 带了面板会渲染一行空白的说明。 */
function withNotes<T extends object>(base: T, notes: string): T & { notes?: string } {
	return notes === "" ? base : { ...base, notes };
}

/**
 * 注册表按上面的 schema 补完默认值、挡掉不在选项里的值之后,交过来的就是这个形状 ——
 * `run` 里那一句断言只是把 schema 已经保证的事告诉编译器。
 */
type UpdateScenarioValues = {
	phase: UpdateState["phase"];
	code: UpdateFailureCode;
	disabledReason: "no-keys" | "dev-build";
	target: string;
	notes: string;
};

const DEFAULT_TARGET = "0.99.0";

function buildState(p: UpdateScenarioValues): UpdateState {
	const now = new Date().toISOString();
	// 输入框被清空时注册表给的是空串(默认值只在这个键**缺席**时才补)。空版本号会渲染成
	// 一张没有版本号的卡,「查看发布页」还指到 `.../tag/v`。
	const target = p.target === "" ? DEFAULT_TARGET : p.target;
	const releaseUrl = releaseUrlOf(target);
	switch (p.phase) {
		case "disabled":
			return { phase: "disabled", reason: p.disabledReason };
		case "idle":
			return { phase: "idle" };
		case "up-to-date":
			return { phase: "up-to-date", checkedAt: now };
		case "available":
			return withNotes({ phase: "available", target, releaseUrl, checkedAt: now }, p.notes);
		case "downloading":
			return withNotes({ phase: "downloading", target, releaseUrl }, p.notes);
		case "ready":
			return withNotes({ phase: "ready", target, releaseUrl }, p.notes);
		case "needs-image-pull":
			return withNotes({ phase: "needs-image-pull", target, releaseUrl, checkedAt: now }, p.notes);
		case "rolled-back":
			return { phase: "rolled-back", target };
		case "error":
			return { phase: "error", code: p.code, helpUrl: RELEASES_PAGE_URL, checkedAt: now };
	}
}

/** 生效条上那句:带版本号的相位把版本号也念出来。 */
function labelOf(state: UpdateState): string {
	const target = "target" in state ? ` ${state.target}` : "";
	const reason = state.phase === "error" ? ` (${state.code})` : "";
	return `更新状态 → ${state.phase}${target}${reason}`;
}

export function updateStateScenario(injectable: InjectableUpdateService): DevScenarioDef {
	return {
		id: "update.state",
		group: "state",
		title: "更新状态",
		desc: "换掉面板看到的更新状态(系统页那一节、概览系统卡;刷新页面注入也还在)。跑完会当场重放一次「打开面板那次自动检查」,所以右下角的通知卡也立刻弹。只有在这里收摊才复原;注入 ready 后按「立即重启并应用」会真的退出进程。",
		quick: true,
		icon: "download",
		params: [
			{ key: "phase", label: "相位", kind: "enum", options: PHASES, default: "available" },
			{
				key: "code",
				label: "归因(error 时)",
				kind: "enum",
				options: FAILURE_CODES,
				default: "unreachable",
			},
			{
				key: "disabledReason",
				label: "关着的理由(disabled 时)",
				kind: "enum",
				options: [
					{ value: "dev-build", label: "dev-build · 开发版" },
					{ value: "no-keys", label: "no-keys · 没内置公钥" },
				],
				default: "dev-build",
			},
			{ key: "target", label: "目标版本", kind: "text", default: DEFAULT_TARGET },
			{
				key: "notes",
				label: "版本概述",
				kind: "text",
				default: "devtools 造的一版:把假更新说明念给通知卡听。",
			},
		],
		run(params) {
			injectable.inject(buildState(params as UpdateScenarioValues));
			return ok();
		},
		active() {
			const state = injectable.injected();
			return state === null ? null : { scenarioId: "update.state", label: labelOf(state) };
		},
		reset() {
			injectable.clear();
		},
	};
}
