import { probeAiProvider } from "@bilibili-notify/ai";
import { aiProfileAt, fail, ok, type Result } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { type ConfigStore, ConfigValidationError, type SettingsSnapshot } from "../config/store.js";
import type { PuppeteerAdapter } from "../runtime/puppeteer.js";
import { checkCommandAliases } from "./command-alias-guard.js";
import { maskedCellsFailure } from "./masked-cells.js";
import { readJsonObject } from "./request-body.js";
import { respondFailure } from "./respond-failure.js";
import { checkApprovalReachable } from "./roast-approval-guard.js";
import { globalConfigView } from "./secret-view.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/settings` — read + patch the runtime settings: the core GlobalConfig plus each registered
 * integration's settings under its key (today `bilibili`, ADR-0021 decision 42's 10-01 🔗).
 *
 * - GET: returns a snapshot (core keys at the top level, each integration's settings under its key)
 * - PATCH: accepts a deep-partial JSON body in the same shape, merges, validates, persists —
 *   core and integration parts in one go (all validated before anything is written)
 *
 * No PUT (full set) — keep the API surface deliberately small until a UI demands it.
 *
 * Enable-check pre-flight (plan: 启用前验证):
 * When the resulting config would have `defaults.cards.enabled = true` or
 * `ai.enabled = true`, we actively probe before letting the patch
 * land. For image we require puppeteer to be wired AND able to spawn a page;
 * for AI we require apiKey/baseUrl/model + a successful OpenAI-compatible
 * chat completion. 没过的一律是带标准码的失败(ADR-0026),`message` 面板原样内联显示
 * (Cards.tsx / Ai.tsx 已把 `ApiError.message` 接进各自的错误条):要主人先去配的
 * (没配 Chrome / key 是空的 / key 被拒 / 审批没有可用的私聊通道)是 `not_configured` 409,
 * 对端暂时不通的是 `unavailable`,超时是 `timeout`,被限速是 `rate_limited`。
 * 别名撞名是 `conflict` 409,拓展设置走错了口子是 `invalid`。
 */
export function createSettingsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) =>
		c.json(
			publicSettings({
				core: deps.store.getGlobals(),
				integrations: deps.store.getAllIntegrationSettings(),
			}),
		),
	);

	app.patch("/", async (c) => {
		// We accept any shape here; the merged result is re-validated by Zod inside the store.
		// Cheap upfront guard: must be an object (not array / scalar).
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		// 各集成的设置按登记过的键拆出去,其余是核心那份。集成那份的格式与写入校验(B 站的 cron 能不能解析)
		// 都在配置仓按登记的格式做,这里不认得任何一个集成。
		const { core: body, integrations } = splitSettingsPatch(read.body, deps.store);
		// 拓展设置有自己的口了(ADR-0019 决策 35),这里一格都不收 —— 老面板(应用内更新那几秒里
		// 还开着的那一页)会整份写回,得拒掉并说清去哪儿写。先于别的检查:这一发整个作废。
		const moved = extensionSettingsWriteOf(body);
		if (moved) return respondFailure(c, fail("invalid", moved));
		// 密钥格下发时是 `{ masked }`(只读的遮挡):带着它写回一律 400 —— 没动的格面板不发,不带 = 保留已存的。
		const masked = maskedCellsFailure(read.body);
		if (masked) return respondFailure(c, masked);
		const patch = body;
		// 别名冲突:撞了就静默失灵一条指令,主人根本查不到是别名干的。堵在保存这一刻,
		// 并说清跟谁撞了。(dispatcher 重建时还有第二道,但那道只能记日志。)
		const aliasCheck = checkCommandAliases({
			current: deps.store.getGlobals(),
			patch,
			commands: deps.commands ?? [],
		});
		if (!aliasCheck.ok) return respondFailure(c, aliasCheck);
		// Enable-check pre-flight. Runs against the *merged* view so a request
		// that only toggles `enabled=true` without restating apiKey still works
		// (we read the still-persisted value as the effective field).
		const enableCheck = await runEnableCheck({
			current: deps.store.getGlobals(),
			patch,
			puppeteer: deps.puppeteer,
			targets: deps.store.getTargets(),
			connections: deps.store.getConnections(),
			// 引擎还没起来时取不到能力,按「还不知道」算。
			capabilitiesOf: (id) => deps.runtime.engines?.connectionCapabilities(id),
		});
		if (!enableCheck.ok) return respondFailure(c, enableCheck);
		try {
			const next = await deps.store.patchSettings({
				// 只送了集成那份就别碰核心:空补丁也会重写一遍核心、广播一次 globals 改动。
				...(Object.keys(patch).length > 0 ? { core: patch } : {}),
				...(Object.keys(integrations).length > 0 ? { integrations } : {}),
			});
			return c.json(publicSettings(next));
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("PATCH /api/settings failed", err);
			throw err;
		}
	});

	return app;
}

/**
 * 这一发会不会写到某个拓展的**设置** —— 会的话回拒掉时说的那句话,不会回 `undefined`。
 *
 * 拓展设置有自己的读写口 `/api/ext/:id/settings`(ADR-0019 决策 35):按项写、带版本号。这里整份
 * 写回的话,两发交错会丢一发、`id` 与密钥占位一起被盖掉 —— 所以一格都不收。三种写法都算:
 * - 带了 `extensions.<id>.settings`(老面板就这么写);
 * - `extensions.<id>` 整格清成 `null` —— 连设置一起抹掉(卸载有自己的口,`DELETE /api/ext/:id`);
 * - `extensions` 整张表不是对象(`null` 同理,抹掉的是所有拓展的)。
 *
 * 只拨开关(`extensions.<id>.enabled`)照旧放行:开关不是设置。
 */
function extensionSettingsWriteOf(patch: Record<string, unknown>): string | undefined {
	if (!("extensions" in patch)) return undefined;
	const table = patch.extensions;
	const moved = (id: string) =>
		`拓展设置不再经 /api/settings 写,改走 /api/ext/${id}/settings(按项写、带版本号)—— ` +
		"这个面板多半是更新之前的旧版,刷新一下再改";
	if (typeof table !== "object" || table === null || Array.isArray(table)) {
		return "拓展表不能经 /api/settings 整张替换或清掉 —— 开关逐个拨(extensions.<id>.enabled),设置走 /api/ext/<id>/settings";
	}
	for (const [id, slot] of Object.entries(table)) {
		if (slot === null) {
			return `拓展 ${id} 那一格不能经 /api/settings 整个清掉(连它的设置一起)—— 卸载走 DELETE /api/ext/${id}`;
		}
		if (typeof slot === "object" && "settings" in slot) return moved(id);
	}
	return undefined;
}

/**
 * 请求体按登记过的集成键拆开:那几个键的值是各集成那份设置的补丁,其余是核心那份的。集成的键与核心的顶层键
 * 不会撞名(配置仓登记时就拦了)。
 */
function splitSettingsPatch(
	body: Record<string, unknown>,
	store: Pick<ConfigStore, "getAllIntegrationSettings">,
): { core: Record<string, unknown>; integrations: Record<string, unknown> } {
	const keys = new Set(Object.keys(store.getAllIntegrationSettings()));
	const core: Record<string, unknown> = {};
	const integrations: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (keys.has(key)) integrations[key] = value;
		else core[key] = value;
	}
	return { core, integrations };
}

/**
 * 下发给浏览器的那一份:核心的顶层键原样摆着,各集成的设置挂在自己的键下(与 PATCH 收的同一个形状)。今天登记的
 * 集成设置里没有密钥;将来有了,按字段表上的 `secret` 标记打码(ADR-0021 决策 44,随 3b)。
 */
function publicSettings(snapshot: SettingsSnapshot): Record<string, unknown> {
	// 核心那份的密钥换遮挡(`globalConfigView`,按 schema 上的 `secret` 标记)。拓展的设置不在这里面(各在自己的文件里,ADR-0021 决策 42 下
	// 10-01 的 🔗),核心那份只有它们的开关 —— 拓展设置里的密钥(桥的 token、抖音的 cookie)只从
	// `/api/ext/:id/settings` 那一口出门,在那儿遮(服务端算头尾,决策 35)。
	return { ...globalConfigView(snapshot.core), ...snapshot.integrations };
}

// ---------------------------------------------------------------------------
// Enable check
// ---------------------------------------------------------------------------

interface EnableCheckArgs {
	current: import("@bilibili-notify/internal").GlobalConfig;
	patch: Record<string, unknown>;
	puppeteer: PuppeteerAdapter | null;
	targets: readonly import("@bilibili-notify/internal").PushTarget[];
	connections: readonly import("@bilibili-notify/internal").Connection[];
	/** 一条连接眼下的能力;审批开关据主人目标那条连接的 `inbound` 判。 */
	capabilitiesOf: (
		connectionId: string,
	) => import("@bilibili-notify/internal").ConnectionCapabilities | undefined;
}

/**
 * 审批开关的前置检查。
 *
 * 审批靠主人在 IM 里回一句 `y` 才走得下去,而独立端的推送通道**大多只出不进**
 * —— webhook 更是天生没有回程(它就是个出站 HTTP POST)。在一个收不到回复的通道
 * 上把审批打开,结果是每期周报都生成、都私聊、然后 48 小时后全部超时作废,一份
 * 也发不出去,而配置页上看着一切正常。所以宁可不给开,并说清该去改什么。
 *
 * 判据是**主人那条私聊通道**所在的平台 —— 草稿预览就是发给他的。
 */
export function checkApprovalEnable(
	current: import("@bilibili-notify/internal").GlobalConfig,
	patch: Record<string, unknown>,
	targets: readonly import("@bilibili-notify/internal").PushTarget[],
	connections: readonly import("@bilibili-notify/internal").Connection[],
	capabilitiesOf: (
		connectionId: string,
	) => import("@bilibili-notify/internal").ConnectionCapabilities | undefined,
): Result {
	// 同 per-scope gating:这次 patch 没碰 roastSchedule 就别插手,
	// 否则存别的 tab 会被一个早就存在的 approval=true 拦住。
	if (pluck(patch, ["roastSchedule"]) === undefined) return ok();
	const approval = mergedFlag(
		current.roastSchedule.approval,
		pluck(patch, ["roastSchedule", "approval"]),
	);
	if (!approval) return ok();

	// 判据、话术与码(`not_configured`)住在 roast-approval-guard —— per-UP 那条(subs PATCH)用的是同一份。
	return checkApprovalReachable({
		approvalOn: true,
		masterTargetId: current.master.targetId,
		targets,
		connections,
		capabilitiesOf,
	});
}

async function runEnableCheck(args: EnableCheckArgs): Promise<Result> {
	// Per-scope gating: the check only fires when *this* PATCH actually touches
	// the scope. Otherwise saving the Cards tab would re-validate the live AI
	// connection (and vice versa) simply because the persisted state already had
	// `enabled = true`. Each dashboard tab now only validates what it owns.
	const touchesCards = pluck(args.patch, ["defaults", "cards"]) !== undefined;

	if (touchesCards) {
		const cardEnabled = mergedFlag(
			args.current.defaults.cards.enabled,
			pluck(args.patch, ["defaults", "cards", "enabled"]),
		);
		if (cardEnabled) {
			const r = await checkCardEnable(args.puppeteer);
			if (!r.ok) return r;
		}
	}

	const approvalCheck = checkApprovalEnable(
		args.current,
		args.patch,
		args.targets,
		args.connections,
		args.capabilitiesOf,
	);
	if (!approvalCheck.ok) return approvalCheck;

	if (shouldRunAiEnableCheck(args.current, args.patch)) {
		// 探活要打的是**本次保存之后**生效的那份实例:activeProfile 指针本身可能
		// 就在这个 patch 里被换掉了。拿旧指针去取连接字段,会用 A 家的 key 打 B 家的接口。
		const id = aiActiveProfileAfterPatch(args.current, args.patch);
		const cur = aiProfileAt(args.current.ai.providers, id);
		const at = (field: string) =>
			mergedString(
				cur?.[field as "apiKey" | "baseUrl" | "model" | "apiFlavor"],
				pluck(args.patch, ["ai", "providers", id, field]),
			);
		const r = await probeAiProvider({
			apiKey: at("apiKey"),
			baseUrl: at("baseUrl"),
			model: at("model"),
			// 风味也可能就在这个 patch 里被切换 —— 与连接字段同一套 merged 取法。
			apiFlavor: at("apiFlavor") || "chat",
		});
		if (!r.ok) return r;
	}

	return ok();
}

/** 本次 patch 生效后当前用哪份实例 —— 指针可能就在这个 patch 里被换掉。 */
export function aiActiveProfileAfterPatch(
	current: import("@bilibili-notify/internal").GlobalConfig,
	patch: Record<string, unknown>,
): string {
	const inPatch = pluck(patch, ["ai", "activeProfile"]);
	return typeof inPatch === "string" ? inPatch : current.ai.activeProfile;
}

/**
 * AI 连接探活(probeAiProvider,会真打一次 chat/completions 请求)是否该跑。三种情况:
 *  1. 本次 patch 把当前那份实例的连接字段 apiKey / baseUrl / model **改成跟 current 不同的新值**;
 *  2. 本次 patch **换了实例** —— 换实例就是换连接,新那份的 key 还没验过;
 *  3. 本次 patch 把 ai.enabled 从 false 翻成 true(启用动作本身要验)。
 * 改 persona / prompt 不触发探活;AI 最终为禁用态时一律不跑。
 *
 * 「值跟 current 相同也不触发」是为兼容前端整段 patch 风格 —— Ai.tsx save mutation
 * 把整段 `ai` 原样送上,只改 persona 时连接字段也跟着进 patch,
 * 仅判断「字段在 patch 里」会误触探活。apiKey 面板没动时不进 patch(下发的是遮挡,
 * 带着它写回是 400),pluck 自然取不到。
 */
export function shouldRunAiEnableCheck(
	current: import("@bilibili-notify/internal").GlobalConfig,
	patch: Record<string, unknown>,
): boolean {
	const aiEnabled = mergedFlag(current.ai.enabled, pluck(patch, ["ai", "enabled"]));
	if (!aiEnabled) return false;

	const id = aiActiveProfileAfterPatch(current, patch);
	const switchedProfile = id !== current.ai.activeProfile;
	const cur = aiProfileAt(current.ai.providers, id);
	const changed = (field: "apiKey" | "baseUrl" | "model") => {
		const inPatch = pluck(patch, ["ai", "providers", id, field]);
		return inPatch !== undefined && inPatch !== cur?.[field];
	};
	const touchesConnection = changed("apiKey") || changed("baseUrl") || changed("model");
	const enabling = !current.ai.enabled && aiEnabled;
	return switchedProfile || touchesConnection || enabling;
}

// ── Image / puppeteer probe ────────────────────────────────────────────────

async function checkCardEnable(puppeteer: PuppeteerAdapter | null): Promise<Result> {
	if (!puppeteer) {
		// 要主人先去配,等是等不好的。
		return fail(
			"not_configured",
			"chromePath / chromeEndpoint 均未配置，无法启用卡片渲染。请在服务端 yaml 或环境变量（BN_CHROME_PATH 本地浏览器路径 / BN_CHROME_ENDPOINT 远程浏览器端点）中配置后重启。",
		);
	}
	try {
		const page = await puppeteer.page();
		try {
			await page.close();
		} catch {
			// best-effort; closing the probe page should not surface
		}
		return ok();
	} catch (err) {
		// 探活的目的就是告诉主人「为什么起不来」,所以底层的话(err.message)留在 message 里;
		// 分不清是路径配错还是浏览器一时起不来,按「暂时不可用」回。
		const detail = err instanceof Error ? err.message : String(err);
		return fail(
			"unavailable",
			`puppeteer 启动失败：${detail}。请确认 chromePath 指向可执行的 Chromium / Chrome 二进制，或 chromeEndpoint 指向可达的远程浏览器。`,
		);
	}
}

// ── Merge helpers ──────────────────────────────────────────────────────────

function pluck(root: Record<string, unknown>, path: string[]): unknown {
	let cur: unknown = root;
	for (const key of path) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

function mergedFlag(current: boolean, patchValue: unknown): boolean {
	return typeof patchValue === "boolean" ? patchValue : current;
}

function mergedString(current: string | undefined, patchValue: unknown): string {
	if (typeof patchValue === "string") return patchValue.trim();
	return (current ?? "").trim();
}
