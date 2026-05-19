/**
 * Standalone-side engine wiring. Mirrors what koishi/dynamic + koishi/live do
 * for the koishi shell, but driven by the file-backed ConfigStore + MultiplexSink
 * instead of koishi's Service / Context plumbing.
 *
 * Construction order (same constraints as the koishi side):
 *
 *   1. Bind SubscriptionStore to ConfigStore
 *   2. Build MultiplexNotificationSink (subscribers: HistoryStore via onDelivery)
 *   3. Construct BilibiliPush({ sink, store, master })
 *   4. Optionally construct CommentaryGenerator (when apiKey + baseUrl set; the
 *      `enabled` flag is enforced at engine-config gating layer in step 5/6)
 *   5. Construct DynamicEngine + LiveEngine with PushLike adapters
 *   6. Wire subscription-changed → engine.applyOps; auth-restored → engine reseed
 *   7. Wire config-changed (globals scope) → DynamicEngine.updateConfig + LiveEngine.updateConfig
 *
 * Engine-stop is registered with serviceCtx.onDispose; the runtime's dispose()
 * propagates correctly.
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import { CommentaryGenerator } from "@bilibili-notify/ai";
import type { BilibiliAPI } from "@bilibili-notify/api";
import {
	DynamicEngine,
	type DynamicEngineConfig,
	type PushLike as DynamicPushLike,
	type SubscriptionOpView as DynamicSubOp,
	type SubscriptionsView as DynamicSubsView,
	type PushSegment,
} from "@bilibili-notify/dynamic";
import { ImageRenderer, type PuppeteerLike } from "@bilibili-notify/image";
import type {
	Disposable,
	FeatureKey,
	GlobalConfig,
	HistorySource,
	NotificationPayload,
	PayloadSegment,
	PushTarget,
	Subscription,
	SubscriptionOp,
} from "@bilibili-notify/internal";
import { resolve } from "@bilibili-notify/internal";
import {
	LiveEngine,
	type LiveEngineConfig,
	type PushLike as LivePushLike,
	type LiveSubscriptionOp,
	type SubscriptionsView as LiveSubsView,
	type SubItemView as LiveSubView,
} from "@bilibili-notify/live";
import { BilibiliPush } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import type { ConfigStore } from "../config/store.js";
import type { HistoryStore } from "../history/store.js";
import type { PlatformAdapter, ProbeResult } from "../platforms/types.js";
import { createMultiplexSink } from "../sink/multiplex.js";
import { segmentToPayload, standaloneContentBuilder } from "./content-builder.js";
import { MasterNotifier } from "./master-notifier.js";
import type { NodeServiceContext } from "./service-context.js";
import type { SubRuntimeStore } from "./sub-runtime-store.js";

export interface ModuleStatus {
	/** DynamicEngine cron is wired. Always true once the runtime boots. */
	dynamic: boolean;
	/** LiveEngine has at least one subscription that would open a listener. */
	live: boolean;
	/** ImageRenderer is wired (puppeteer available) AND `cardStyle.enabled`. */
	image: boolean;
	/** CommentaryGenerator is wired (apiKey + baseUrl present) AND `ai.enabled`. */
	ai: boolean;
}

export interface LiveListenerSnapshot {
	uid: string;
	roomId: string;
	isLive: boolean;
	title?: string;
	cover?: string;
	areaName?: string;
	startedAt?: string;
	/** B 站 WATCHED_CHANGE 帧给出的累计观看(预格式化字符串,如 "1.2万")。 */
	viewers?: string;
}

export interface EnginesRuntime extends Disposable {
	readonly dynamic: DynamicEngine;
	readonly live: LiveEngine;
	readonly push: BilibiliPush;
	readonly subscriptionStore: SubscriptionStore;
	readonly commentary: CommentaryGenerator | null;
	/** Started BilibiliAPI; consumed by routes that need ad-hoc B-station calls (e.g. subs lookup). */
	readonly api: BilibiliAPI;
	/** Currently-broadcasting rooms; powers /api/live/listening. */
	listLiveRooms(): LiveListenerSnapshot[];
	/** Out-of-band reachability probe for `/api/adapters/:id/test`. */
	probeAdapter(adapterId: string): Promise<ProbeResult>;
	/** Per-module readiness snapshot exposed via `/api/health`. */
	getModuleStatus(): ModuleStatus;
}

export interface CreateEnginesOptions {
	/**
	 * NodeServiceContext (not the platform-neutral ServiceContext) — engines.ts
	 * uses `forSubsystem(name, level)` to give each engine its own pino instance
	 * driven by globals.app.logLevels.{dynamic,live,image,ai}. The standalone
	 * runtime constructs the parent context once at boot.
	 */
	serviceCtx: NodeServiceContext;
	api: BilibiliAPI;
	/**
	 * Auth subsystem 的 LoginFlow 实例。engines.ts 用它在 config-changed 时
	 * 把 `app.healthCheckMinutes` 热推到登录健康检查定时器。
	 */
	loginFlow: import("@bilibili-notify/api").LoginFlow;
	configStore: ConfigStore;
	historyStore: HistoryStore;
	subscriptionStore: SubscriptionStore;
	/**
	 * Display-cache source for uname/uavatar (history snapshot + engine sub
	 * views). cachedProfile was externalized out of `Subscription`, so the
	 * config subs from subscriptionStore no longer carry it — read it here.
	 */
	subRuntimeStore: SubRuntimeStore;
	bus: import("@bilibili-notify/internal").MessageBus;
	adapters: PlatformAdapter[];
	/**
	 * Optional puppeteer adapter. When provided the engines spin up a shared
	 * {@link ImageRenderer} so live / dynamic cards render to JPEG instead of
	 * falling back to plain text. When null (no BN_CHROME_PATH), pushes go out
	 * as the engines' text-only fallback path.
	 */
	puppeteer?: PuppeteerLike | null;
}

export function createEngines(opts: CreateEnginesOptions): EnginesRuntime {
	const log = opts.serviceCtx.logger;
	// Per-module sub-contexts. Subsystem level falls back to `app.logLevel`
	// when its module-specific override is absent (schema doc spells this out).
	// Pino levels are mutable, so `config-changed: globals` later pushes new
	// levels onto these instances without a server restart.
	const initialGlobals = opts.configStore.getGlobals();
	const resolveLevel = (
		g: GlobalConfig,
		key: "core" | "dynamic" | "live" | "image" | "ai",
	): string => g.app.logLevels?.[key] ?? g.app.logLevel;
	const dynamicCtx = opts.serviceCtx.forSubsystem(
		"dynamic",
		resolveLevel(initialGlobals, "dynamic"),
	);
	const liveCtx = opts.serviceCtx.forSubsystem("live", resolveLevel(initialGlobals, "live"));
	const aiCtx = opts.serviceCtx.forSubsystem("ai", resolveLevel(initialGlobals, "ai"));
	const imageCtx = opts.serviceCtx.forSubsystem("image", resolveLevel(initialGlobals, "image"));
	const globals = (): GlobalConfig => opts.configStore.getGlobals();

	// Base logger boot reconcile. bootstrap.logLevel (BN_LOG_LEVEL / --log-level
	// / bn.config logLevel) only governs the pre-engines early window (config
	// load + bootstrap, before globals.json is applied). From engines-up onward
	// the base logger is the "core" module bucket — every non-engine log
	// (push / sink / master-notifier / fans-poller / routes / config / history /
	// ws) goes through it, so it follows `logLevels.core ?? app.logLevel` just
	// like the subsystem ctxs follow their own keys. Apply once here so it does
	// NOT wait for the first config-changed. Mirrors the change-path apply below.
	opts.serviceCtx.setLevel(resolveLevel(initialGlobals, "core"));

	// 启动期把 app.userAgent 推到 BilibiliAPI(auth/index.ts 构造时未填,这里补)。
	// config-changed 路径下方也会再次调用,变更立即生效。
	opts.api.setUserAgent(globals().app.userAgent);

	// ---------- Sink + push ----------
	// onDelivery 只负责 target.testStatus 同步 —— sink 拿不到 uid + feature,
	// 没法填 history 的 source / uid 字段。history 写入挂到 BilibiliPush.onSend
	// (见下方),那里能拿到完整的发起上下文。
	const sink = createMultiplexSink({
		store: opts.configStore,
		adapters: opts.adapters,
		logger: log,
		onDelivery: (target, _payload, result) => {
			const prev = target.testStatus;
			if (!prev || prev.ok !== result.ok) {
				const nextStatus = {
					ok: result.ok,
					lastCheckedAt: new Date().toISOString(),
					latencyMs: result.latencyMs,
					err: result.err,
				};
				void opts.configStore
					.patchTarget(target.id, { testStatus: nextStatus })
					.catch((e) =>
						log.warn(`[sink] target ${target.id} testStatus writeback failed: ${String(e)}`),
					);
			}
		},
	});

	const masterTarget = (): PushTarget | undefined => {
		const id = globals().master.targetId;
		if (!id) return undefined;
		return opts.configStore.getTargets().find((t) => t.id === id);
	};

	const push = new BilibiliPush({
		sink,
		store: opts.subscriptionStore,
		master: masterTarget() ?? null,
		logger: log,
		serviceCtx: opts.serviceCtx,
		defaults: () => globals().defaults,
		onSend: (info) => {
			// 私聊不走 history(语义上是给主人的运行状态通知,不是订阅推送)。
			if (info.private) return;
			const sub = opts.subscriptionStore.findByUid(info.uid);
			const rt = sub ? opts.subRuntimeStore.get(sub.id) : undefined;
			void opts.historyStore
				.append({
					source: featureToHistorySource(info.feature),
					uid: info.uid,
					subscriptionId: sub?.id ?? info.target.id,
					targets: [
						{
							targetId: info.target.id,
							ok: info.result.ok,
							latencyMs: info.result.latencyMs,
							err: info.result.err,
						},
					],
					payload: info.payload,
					// Snapshot UP 主当时的名字 / 头像。订阅以后被删除,Dashboard 的
					// timeline / history 仍能正确显示「当时是谁」,不退化成 UID 占位。
					unameSnapshot: rt?.cachedProfile?.name,
					uavatarSnapshot: rt?.cachedProfile?.avatar,
				})
				.catch((e) => log.warn(`[history] append failed: ${String(e)}`));
		},
	});
	push.start();

	// ---------- Master notifier ----------
	// engine-error / auth-lost → 主人 OneBot 私聊。共用一张 per-source 60s 节流表。
	// Web dashboard 上同样会通过 AlertShell 看到 engine-error;两路通道互不影响。
	const masterNotifier = new MasterNotifier({ bus: opts.bus, push, logger: log });
	masterNotifier.install();

	// ---------- AI (optional) ----------
	// 构造仅依赖 apiKey / baseUrl 是否齐备 —— 与 `enabled` 解耦,后者交给引擎 config 层
	// 的 aiEnabled flag 在每次推送前热判断。这样用户在 dashboard 把 AI 开关切关再切开
	// 不需要重启服务。完整字段变更则走下方 `rebuildCommentary` 重建实例。
	//
	// 字段名映射:schema 用 `baseRole` / `extraSystemPrompt` (面向用户的字段名),
	// CommentaryGenerator 的 PersonaConfig 用 `customBase` / `extraPrompt` (历史
	// 命名,与 koishi 端的 PersonaConfig 一致)。在这里做一次性翻译,引擎层不感知差异。
	const buildAiConfig = () => {
		const a = globals().defaults.ai;
		return {
			apiKey: a.apiKey ?? "",
			baseURL: a.baseUrl ?? "",
			model: a.model,
			// `temperature` 是 CommentaryGeneratorConfig 的 optional 字段;dashboard 滑块
			// 改值后,config-changed 路径下方 `commentary.updateConfig(buildAiConfig())` 会把
			// 新值推到引擎,下次 chat.completions.create 即生效。
			temperature: a.temperature,
			persona: {
				preset: "custom" as const,
				name: a.persona.name,
				addressUser: a.persona.addressUser,
				addressSelf: a.persona.addressSelf,
				traits: a.persona.traits,
				catchphrase: a.persona.catchphrase,
				customBase: a.persona.baseRole,
				extraPrompt: a.persona.extraSystemPrompt,
			},
			dynamicPrompt: a.dynamicPrompt,
			liveSummaryPrompt: a.liveSummaryPrompt,
			enableConversation: false,
			maxHistory: 6,
			enableThinking: false,
			enableSearch: false,
			enableVision: false,
		};
	};

	let commentary: CommentaryGenerator | null = null;
	const buildCommentary = (): CommentaryGenerator | null => {
		const a = globals().defaults.ai;
		if (!a.apiKey || !a.baseUrl) return null;
		try {
			const c = new CommentaryGenerator({
				serviceCtx: aiCtx,
				api: opts.api,
				config: buildAiConfig(),
			});
			c.start();
			return c;
		} catch (err) {
			log.warn(`[ai] commentary init failed: ${String(err)}`);
			return null;
		}
	};
	commentary = buildCommentary();

	// ---------- ImageRenderer (optional) ----------
	// Constructed once when puppeteer is wired (BN_CHROME_PATH / chromePath set).
	// `cardStyle.enabled` is enforced inside DynamicEngine / LiveEngine via the
	// `imageEnabled` config field; when false the engines bypass the renderer
	// and emit text-only payloads, so we still construct the instance to avoid
	// hot-swapping on the user toggling the switch.
	let imageRenderer: ImageRenderer | null = null;
	if (opts.puppeteer) {
		const cs = globals().defaults.cardStyle;
		imageRenderer = new ImageRenderer({
			serviceCtx: imageCtx,
			puppeteer: opts.puppeteer,
			config: {
				cardColorStart: cs.cardColorStart,
				cardColorEnd: cs.cardColorEnd,
				font: "PingFang SC, sans-serif",
				hideDesc: false,
				followerDisplay: true,
			},
		});
		imageRenderer.start();
	}

	// ---------- DynamicEngine ----------
	const dynamicPushLike: DynamicPushLike = {
		async broadcastDynamic(uid, segments, _kind) {
			const payload = pushSegmentsToPayload(segments);
			await push.broadcastToFeature(uid, "dynamic", payload);
		},
		sendPrivateMsg: (text) => push.sendPrivateMsg(text),
		sendErrorMsg: (text) => push.sendErrorMsg(text),
	};

	const dynamicConfig = (): DynamicEngineConfig => {
		const f = globals().defaults.filters;
		// New schema uses array-of-regex while the engine takes a single combined
		// regex string; join with `|` (capturing-group safe since users supply
		// alt patterns themselves).
		const blockHasRules =
			f.blockKeywords.length > 0 || f.blockRegex.length > 0 || f.blockForward || f.blockArticle;
		const whitelistHasRules = f.whitelistKeywords.length > 0 || f.whitelistRegex.length > 0;
		return {
			dynamicUrl: true,
			dynamicCron: globals().app.dynamicCron,
			dynamicVideoUrlToBV: false,
			pushImgsInDynamic: true,
			imageEnabled: globals().defaults.cardStyle.enabled,
			aiEnabled: globals().defaults.ai.enabled,
			filter: {
				enable: blockHasRules,
				notify: false,
				regex: f.blockRegex.join("|"),
				keywords: f.blockKeywords,
				forward: f.blockForward,
				article: f.blockArticle,
				whitelistEnable: whitelistHasRules,
				whitelistRegex: f.whitelistRegex.join("|"),
				whitelistKeywords: f.whitelistKeywords,
			},
		};
	};

	const dynamic = new DynamicEngine({
		serviceCtx: dynamicCtx,
		bus: opts.bus,
		api: opts.api,
		push: dynamicPushLike,
		image: imageRenderer ?? undefined,
		ai: commentary ?? undefined,
		config: dynamicConfig(),
		getSubs: () => buildDynamicSubsView(opts.subscriptionStore, opts.subRuntimeStore, globals()),
	});
	dynamic.start();

	// ---------- LiveEngine ----------
	const livePushLike: LivePushLike = {
		async broadcastToTargets(uid, content, type) {
			const feature = liveTypeToFeature(type as number);
			const segments = segmentToPayload(content);
			const payload = collapseSegments(segments);
			await push.broadcastToFeature(uid, feature, payload);
		},
		sendPrivateMsg: (text) => push.sendPrivateMsg(text),
	};

	const liveConfig = (): LiveEngineConfig => {
		const g = globals();
		return {
			pushTime: g.defaults.schedule.pushTime,
			restartPush: g.defaults.schedule.restartPush,
			minScPrice: g.defaults.filters.minScPrice,
			minGuardLevel: g.defaults.filters.minGuardLevel,
			liveSummaryDefault: g.defaults.templates.liveSummary,
			imageEnabled: g.defaults.cardStyle.enabled,
			aiEnabled: g.defaults.ai.enabled,
			customGuardBuy: {
				enable: g.defaults.templates.guardBuy.enable,
				guardBuyMsg: g.defaults.templates.guardBuy.captain.template,
				captainImgUrl: g.defaults.templates.guardBuy.captain.imageUrl,
				supervisorImgUrl: g.defaults.templates.guardBuy.commander.imageUrl,
				governorImgUrl: g.defaults.templates.guardBuy.governor.imageUrl,
			},
			// Only forward the schema templates when the user opted in via
			// `liveMsgEnabled`. When false, leave the override empty so the engine
			// falls back to `DEFAULT_LIVE_TEMPLATES` in template-renderer.ts (the
			// legacy `-name / -time / -watched` shorthand that users expect by
			// default). The schema fields use `{name}` style and are only honoured
			// when the user explicitly turns on the custom-template switch.
			customLiveMsg: g.defaults.templates.liveMsgEnabled
				? {
						enable: true,
						customLiveStart: g.defaults.templates.liveStart,
						customLive: g.defaults.templates.liveOngoing,
						customLiveEnd: g.defaults.templates.liveEnd,
					}
				: { enable: false },
		};
	};

	const live = new LiveEngine({
		serviceCtx: liveCtx,
		api: opts.api,
		push: livePushLike,
		contentBuilder: standaloneContentBuilder,
		imageRenderer: imageRenderer ?? null,
		commentary: commentary ?? null,
		config: liveConfig(),
		emitEngineError: (msg) => opts.bus.emit("engine-error", "live-engine", msg),
		emitLiveState: (uid, status) => opts.bus.emit("live-state-changed", uid, status),
		emitViewers: (uid, viewers) => opts.bus.emit("live-viewers-changed", uid, viewers),
	});

	// Initialise live with current subs.
	const initialLiveView = buildLiveSubsView(
		opts.subscriptionStore,
		opts.subRuntimeStore,
		globals(),
	);
	if (Object.keys(initialLiveView).length > 0) {
		live.start(initialLiveView);
	}

	// ---------- Bus wiring ----------
	const handles: Disposable[] = [];

	handles.push(
		opts.bus.on("subscription-changed", (ops) => {
			const dynOps = subscriptionOpsToDynamic(
				ops,
				opts.subscriptionStore,
				opts.subRuntimeStore,
				globals(),
			);
			dynamic.applyOps(dynOps);
			const liveOps = subscriptionOpsToLive(
				ops,
				opts.subscriptionStore,
				opts.subRuntimeStore,
				globals(),
			);
			live.applyOps(liveOps, (uid) => {
				const sub = opts.subscriptionStore.findByUid(uid);
				return sub ? buildLiveSubViewSingle(sub, opts.subRuntimeStore, globals()) : undefined;
			});
		}),
	);
	handles.push(
		opts.bus.on("auth-restored", () => {
			live.rebuildFromSubs(
				buildLiveSubsView(opts.subscriptionStore, opts.subRuntimeStore, globals()),
			);
		}),
	);
	handles.push(
		opts.bus.on("auth-lost", () => {
			live.teardown();
		}),
	);
	// ---------- Adapter probe scheduler ----------
	// Background reachability check. Plan §"系统不要主动测试" excludes message-
	// sending probes; this one only calls platformAdapter.probe (no side
	// effects) and writes the result back to adapter.testStatus so the dashboard
	// reflects reality without the user having to click "测试" on every adapter.
	const ADAPTER_PROBE_INTERVAL_MS = 5 * 60 * 1000;
	let probeInFlight = false;
	async function probeAllAdapters(): Promise<void> {
		if (probeInFlight) return;
		probeInFlight = true;
		try {
			for (const adapter of opts.configStore.getAdapters()) {
				if (!adapter.enabled) continue;
				try {
					const result = await sink.probeAdapter(adapter.id);
					if (result.ok === null) continue; // platform doesn't support probe (e.g. webhook)
					await opts.configStore.patchAdapter(adapter.id, {
						testStatus: {
							ok: result.ok,
							lastCheckedAt: new Date().toISOString(),
							latencyMs: result.latencyMs,
							err: result.err,
						},
					});
				} catch (e) {
					log.warn(`[probe] adapter ${adapter.id} update failed: ${String(e)}`);
				}
			}
		} finally {
			probeInFlight = false;
		}
	}

	// Kick off an immediate probe after engines come up, then poll on a timer.
	// `config-changed` for 'adapters' scope triggers an extra immediate probe so
	// the UI reflects new adapters / edits without waiting up to 5 min.
	void probeAllAdapters();
	const probeTimer = setInterval(() => {
		void probeAllAdapters();
	}, ADAPTER_PROBE_INTERVAL_MS);
	// Allow process exit without waiting for the next tick.
	probeTimer.unref?.();

	handles.push(
		opts.bus.on("config-changed", (scope) => {
			// NOTE: we deliberately do NOT trigger probeAllAdapters on 'adapters'
			// config-changed. The probe writes back via patchAdapter → emits
			// 'adapters' config-changed → would re-trigger probeAllAdapters in an
			// emit loop. Users wait at most one 5-min tick after editing an
			// adapter (or click "测试" for an immediate refresh).
			if (scope === "globals" || scope === "targets") {
				// targets 也可能影响 master 解析(被引用的 target 删了 / 改了元数据)。
				// 单独一行先 push,避免后续 globals-only 路径未执行时漏掉。
				push.setMaster(masterTarget() ?? null);
				if (scope === "targets") return;
			}
			if (scope === "globals") {
				// Push log-level changes onto the live pino instances so dashboard
				// edits take effect without a server restart.
				const g = globals();
				opts.serviceCtx.setLevel(resolveLevel(g, "core"));
				dynamicCtx.setLevel(resolveLevel(g, "dynamic"));
				liveCtx.setLevel(resolveLevel(g, "live"));
				aiCtx.setLevel(resolveLevel(g, "ai"));
				imageCtx.setLevel(resolveLevel(g, "image"));
				// User-Agent 直接推到 BilibiliAPI 的 axios default headers。
				opts.api.setUserAgent(g.app.userAgent);
				// healthCheckMinutes 推到 LoginFlow:dispose 旧 setInterval + 按新间隔重 arm。
				opts.loginFlow.setHealthCheckMs(g.app.healthCheckMinutes * 60_000);
				// ImageRenderer 配色热更(仅在已构造时有意义)。
				if (imageRenderer) {
					const cs = g.defaults.cardStyle;
					imageRenderer.updateConfig({
						cardColorStart: cs.cardColorStart,
						cardColorEnd: cs.cardColorEnd,
						font: "PingFang SC, sans-serif",
						hideDesc: false,
						followerDisplay: true,
					});
				}
				dynamic.updateConfig(dynamicConfig());
				live.updateConfig(liveConfig());
				// AI 实例热重载:lazy 构造 + 配置失效降级 + 已存在时增量 updateConfig。
				// 引擎构造时 ai 字段是 snapshot,新建/置空后必须通过 setAi/setCommentary
				// 把引用同步过去,否则永远沿用启动时的 null。
				const a = globals().defaults.ai;
				const needsCommentary = Boolean(a.apiKey && a.baseUrl);
				if (!needsCommentary && commentary) {
					try {
						commentary.stop();
					} catch (e) {
						log.warn(`[ai] commentary.stop on disable failed: ${String(e)}`);
					}
					commentary = null;
					dynamic.setAi(undefined);
					live.setCommentary(null);
				} else if (needsCommentary && !commentary) {
					commentary = buildCommentary();
					dynamic.setAi(commentary ?? undefined);
					live.setCommentary(commentary);
					if (commentary) log.info("[ai] commentary 已激活");
				} else if (commentary) {
					commentary.updateConfig(buildAiConfig());
					log.info(
						`[ai] commentary 配置已更新: model=${a.model}, persona.name=${a.persona.name}, traits=${a.persona.traits}`,
					);
				}
			}
		}),
	);

	// ---------- Disposal ----------
	// index.ts shutdown 既显式调 engines.dispose(),又经 runtime.dispose() 跑
	// serviceCtx.onDispose 钩子(下方 onDispose(dispose))→ 双调。幂等守卫,
	// 避免对各 engine .stop()/.dispose() 二次调用与重复 warn 噪音。
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		clearInterval(probeTimer);
		for (const h of handles.splice(0)) {
			try {
				h.dispose();
			} catch {
				// best-effort
			}
		}
		try {
			dynamic.stop();
		} catch (e) {
			log.warn(`[engines] dynamic.stop failed: ${String(e)}`);
		}
		try {
			live.stop();
		} catch (e) {
			log.warn(`[engines] live.stop failed: ${String(e)}`);
		}
		try {
			commentary?.stop();
		} catch (e) {
			log.warn(`[engines] commentary.stop failed: ${String(e)}`);
		}
		try {
			imageRenderer?.stop();
		} catch (e) {
			log.warn(`[engines] image.stop failed: ${String(e)}`);
		}
		try {
			push.stop();
		} catch (e) {
			log.warn(`[engines] push.stop failed: ${String(e)}`);
		}
		try {
			masterNotifier.dispose();
		} catch (e) {
			log.warn(`[engines] masterNotifier.dispose failed: ${String(e)}`);
		}
	};
	opts.serviceCtx.onDispose(dispose);

	return {
		dynamic,
		live,
		push,
		subscriptionStore: opts.subscriptionStore,
		commentary,
		api: opts.api,
		listLiveRooms: () => listLiveRooms(live),
		probeAdapter: (adapterId: string) => sink.probeAdapter(adapterId),
		getModuleStatus: (): ModuleStatus => {
			const g = globals();
			// "live ready" = at least one enabled subscription has any live-related
			// feature routed to a target. Mirrors the LIVE_ROOM_MASTER_KEYS set
			// inside @bilibili-notify/live's `needsLiveMonitor` plus the two
			// special-user features.
			const liveReady = opts.subscriptionStore.list().some((sub) => {
				if (!sub.enabled) return false;
				const eff = resolve(sub, g.defaults);
				const keys: FeatureKey[] = [
					"live",
					"liveEnd",
					"liveGuardBuy",
					"superchat",
					"wordcloud",
					"liveSummary",
					"specialDanmaku",
					"specialUserEnter",
				];
				return keys.some((k) => (eff.routing[k]?.length ?? 0) > 0);
			});
			return {
				dynamic: true,
				live: liveReady,
				image: imageRenderer !== null && g.defaults.cardStyle.enabled,
				ai: commentary !== null && g.defaults.ai.enabled,
			};
		},
		dispose,
	};
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * BilibiliPush 的 FeatureKey(或 master notify 走的 "private")映射到 history
 * schema 的 7 个分类 source 值。dynamic-engine / live-engine 在 push 时只携带
 * 一个 feature 字段,这里集中翻译,避免每个调用点散列。
 */
function featureToHistorySource(feature: string): HistorySource {
	switch (feature) {
		case "dynamic":
		case "dynamicAtAll":
			return "dynamic";
		case "live":
		case "liveAtAll":
		case "liveEnd":
			return "live";
		case "liveGuardBuy":
			return "guard";
		case "superchat":
			return "sc";
		case "wordcloud":
		case "liveSummary":
			return "live-summary";
		case "specialDanmaku":
			return "special-danmaku";
		case "specialUserEnter":
			return "special-enter";
		default:
			return "dynamic";
	}
}

function pushSegmentsToPayload(segments: PushSegment[]): NotificationPayload {
	if (segments.length === 1 && segments[0]?.type === "text") {
		return { kind: "text", text: segments[0].text };
	}
	if (segments.length === 1 && segments[0]?.type === "image") {
		return {
			kind: "image",
			image: { buffer: segments[0].buffer, mime: segments[0].mime },
		};
	}
	const mapped: PayloadSegment[] = [];
	for (const s of segments) {
		if (s.type === "text") mapped.push({ type: "text", text: s.text });
		else if (s.type === "image") mapped.push({ type: "image", buffer: s.buffer, mime: s.mime });
		else if (s.type === "image-group") {
			for (const url of s.urls) mapped.push({ type: "link", href: url });
		}
	}
	if (mapped.length === 0) return { kind: "text", text: "" };
	return { kind: "composite", segments: mapped };
}

function collapseSegments(segments: PayloadSegment[]): NotificationPayload {
	if (segments.length === 0) return { kind: "text", text: "" };
	if (segments.length === 1) {
		const only = segments[0];
		if (!only) return { kind: "text", text: "" };
		if (only.type === "text") return { kind: "text", text: only.text };
		if (only.type === "image") {
			return { kind: "image", image: { buffer: only.buffer, mime: only.mime } };
		}
	}
	return { kind: "composite", segments };
}

export function liveTypeToFeature(type: number): FeatureKey {
	switch (type) {
		case 0:
		case 3:
			return "live";
		case 4:
			return "liveGuardBuy";
		case 5:
			return "wordcloud";
		case 6:
			return "superchat";
		case 7:
			return "specialDanmaku";
		case 8:
			return "specialUserEnter";
		case 9:
			return "liveEnd";
		case 10:
			return "liveSummary";
		default:
			return "live";
	}
}

/**
 * 把 `EffectiveSubscription.ai` (per-UP 折叠后) 翻译成 CommentaryCallOverride。
 * schema 用「面向用户」的 baseRole / extraSystemPrompt 字段名,而 CommentaryGenerator
 * 的 PersonaConfig 沿用 customBase / extraPrompt 历史命名 —— 这里集中做翻译,
 * 引擎层不感知差异。preset 强制设为 "custom":adapter 已把 inherit / preset.id 在
 * resolve() 里折叠成具体 persona,引擎不需要再走 preset lookup 一次。
 */
function buildAiOverride(eff: ReturnType<typeof resolve>): CommentaryCallOverride {
	return {
		persona: {
			preset: "custom" as const,
			name: eff.ai.persona.name,
			addressUser: eff.ai.persona.addressUser,
			addressSelf: eff.ai.persona.addressSelf,
			traits: eff.ai.persona.traits,
			catchphrase: eff.ai.persona.catchphrase,
			customBase: eff.ai.persona.baseRole,
			extraPrompt: eff.ai.persona.extraSystemPrompt,
		},
		dynamicPrompt: eff.ai.dynamicPrompt,
		liveSummaryPrompt: eff.ai.liveSummaryPrompt,
		temperature: eff.ai.temperature,
	};
}

/**
 * 把 `EffectiveSubscription.filters` 翻译成 dynamic-engine 接受的 DynamicFilterConfig。
 * 数组形态的 blockRegex/whitelistRegex 在 engine 内合并成单一 `|` 正则字符串,与全局
 * filter 的 dynamicConfig() 构造逻辑一致。`notify` 字段固定 false —— 全局也是 false。
 */
function buildDynamicFilter(eff: ReturnType<typeof resolve>) {
	const f = eff.filters;
	const blockHasRules =
		f.blockKeywords.length > 0 || f.blockRegex.length > 0 || f.blockForward || f.blockArticle;
	const whitelistHasRules = f.whitelistKeywords.length > 0 || f.whitelistRegex.length > 0;
	return {
		enable: blockHasRules,
		notify: false,
		regex: f.blockRegex.join("|"),
		keywords: f.blockKeywords,
		forward: f.blockForward,
		article: f.blockArticle,
		whitelistEnable: whitelistHasRules,
		whitelistRegex: f.whitelistRegex.join("|"),
		whitelistKeywords: f.whitelistKeywords,
	};
}

function buildDynamicSubsView(
	store: SubscriptionStore,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): DynamicSubsView {
	const view: DynamicSubsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		const eff = resolve(sub, globals.defaults);
		// features.dynamic 决定是否纳入动态轮询(source-side)。routing 由推送层(BilibiliPush)
		// 在 broadcast 时按 routing 空 = 无 sink 自然兜底——所以 features.dynamic=true /
		// routing.dynamic=[] 的 UP 仍跑 cron,后续加 routing 时下一个轮询周期立即生效。
		const hasDynamic = eff.features.dynamic;
		view[sub.uid] = {
			uid: sub.uid,
			uname: subRuntimeStore.get(sub.id)?.cachedProfile?.name ?? sub.uid,
			dynamic: hasDynamic,
			customCardStyle: {
				enable: true,
				cardColorStart: eff.cardStyle.cardColorStart,
				cardColorEnd: eff.cardStyle.cardColorEnd,
			},
			// 每次 cron tick getSubs() 都会重新跑这里,per-UP filter / aiOverride 改完
			// 下一个轮询周期自动生效,不需要单独 hot-reload 路径。
			filter: buildDynamicFilter(eff),
			aiOverride: buildAiOverride(eff),
		};
	}
	return view;
}

function buildLiveSubsView(
	store: SubscriptionStore,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): LiveSubsView {
	const view: LiveSubsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		view[sub.uid] = buildLiveSubViewSingle(sub, subRuntimeStore, globals);
	}
	return view;
}

function buildLiveSubViewSingle(
	sub: Subscription,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): LiveSubView {
	const eff = resolve(sub, globals.defaults);
	const danmakuUsers = sub.specialUsers.filter((u) => u.kinds.includes("danmaku"));
	const enterUsers = sub.specialUsers.filter((u) => u.kinds.includes("enter"));
	// SubItemView 上每个 feature 的布尔字段 = features.X(source-side gate)。routing 由推送层
	// BilibiliPush 在 broadcastToFeature 时按 routing 空 = 无 sink 自然兜底,这里不再 AND routing。
	// 即:features.X=true / routing.X=[] 的 UP 也开 WS / build payload,加 routing 后下一次事件
	// 立即生效。
	const feat = (k: keyof typeof eff.routing) => eff.features[k];
	return {
		uid: sub.uid,
		uname: subRuntimeStore.get(sub.id)?.cachedProfile?.name ?? sub.uid,
		roomId: "",
		dynamic: feat("dynamic"),
		live: feat("live"),
		liveEnd: feat("liveEnd"),
		liveGuardBuy: feat("liveGuardBuy"),
		superchat: feat("superchat"),
		wordcloud: feat("wordcloud"),
		liveSummary: feat("liveSummary"),
		target: eff.routing,
		customCardStyle: {
			enable: true,
			cardColorStart: eff.cardStyle.cardColorStart,
			cardColorEnd: eff.cardStyle.cardColorEnd,
		},
		// Per-UP 阈值 / 调度 / AI;adapter 在 add 路径上灌入,room-session 在 SC /
		// guard / restartPush / pushTime / liveSummary 调用点先取 sub 值,缺失时回退全局。
		// 已活跃 listener 通过 LiveScopedChange 同步增量更新(`subscriptionOpsToLive`
		// 在 update 分支把这些字段一并带上,LiveEngine.applyOps Object.assign 后即刻生效;
		// pushTime 变化时 engine 额外 rearm 一次 setInterval)。
		minScPrice: eff.filters.minScPrice,
		minGuardLevel: eff.filters.minGuardLevel,
		pushTime: eff.schedule.pushTime,
		restartPush: eff.schedule.restartPush,
		aiOverride: buildAiOverride(eff),
		customLiveMsg: eff.templates.liveMsgEnabled
			? {
					enable: true,
					customLiveStart: eff.templates.liveStart,
					customLive: eff.templates.liveOngoing,
					customLiveEnd: eff.templates.liveEnd,
				}
			: { enable: false },
		customGuardBuy: {
			enable: eff.templates.guardBuy.enable,
			guardBuyMsg: eff.templates.guardBuy.captain.template,
			captainImgUrl: eff.templates.guardBuy.captain.imageUrl,
			supervisorImgUrl: eff.templates.guardBuy.commander.imageUrl,
			governorImgUrl: eff.templates.guardBuy.governor.imageUrl,
		},
		customLiveSummary: {
			enable: true,
			liveSummary: eff.templates.liveSummary,
		},
		customSpecialDanmakuUsers:
			danmakuUsers.length > 0
				? {
						enable: true,
						specialDanmakuUsers: danmakuUsers.map((u) => u.uid),
						msgTemplate: eff.templates.specialDanmaku,
					}
				: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom:
			enterUsers.length > 0
				? {
						enable: true,
						specialUsersEnterTheRoom: enterUsers.map((u) => u.uid),
						msgTemplate: eff.templates.specialUserEnter,
					}
				: { enable: false, msgTemplate: "" },
	};
}

function subscriptionOpsToDynamic(
	ops: SubscriptionOp[],
	store: SubscriptionStore,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): DynamicSubOp[] {
	const out: DynamicSubOp[] = [];
	const hasDyn = (sub: Subscription): boolean => {
		const eff = resolve(sub, globals.defaults);
		return eff.features.dynamic;
	};
	for (const op of ops) {
		if (op.type === "add") {
			out.push({
				type: "add",
				sub: {
					uid: op.sub.uid,
					uname: subRuntimeStore.get(op.sub.id)?.cachedProfile?.name ?? op.sub.uid,
					dynamic: hasDyn(op.sub),
					customCardStyle: op.sub.overrides.cardStyle
						? {
								enable: true,
								cardColorStart: op.sub.overrides.cardStyle.cardColorStart,
								cardColorEnd: op.sub.overrides.cardStyle.cardColorEnd,
							}
						: { enable: false },
				},
			});
		} else if (op.type === "remove") {
			out.push({ type: "delete", uid: op.uid });
		} else {
			const sub = store.findByUid(op.sub.uid);
			if (!sub) continue;
			out.push({
				type: "update",
				uid: op.sub.uid,
				changes: [{ scope: "dynamic", dynamic: hasDyn(sub) }],
			});
		}
	}
	return out;
}

function subscriptionOpsToLive(
	ops: SubscriptionOp[],
	store: SubscriptionStore,
	subRuntimeStore: SubRuntimeStore,
	globals: GlobalConfig,
): LiveSubscriptionOp[] {
	const out: LiveSubscriptionOp[] = [];
	for (const op of ops) {
		if (op.type === "add") {
			out.push({ type: "add", sub: buildLiveSubViewSingle(op.sub, subRuntimeStore, globals) });
		} else if (op.type === "remove") {
			out.push({ type: "delete", uid: op.uid });
		} else {
			const sub = store.findByUid(op.sub.uid);
			if (!sub) continue;
			// 用完整 SubItemView 投影出所有 LiveScopedChange 支持的字段——路由布尔、
			// per-UP 阈值 / 调度 / AI override 之外,模板 / 上舰 / 特别关注 / 卡片样式
			// 也跟着一起同步,避免活跃 listener 用旧值(本来 add 路径就走这里,update
			// 没必要弱化语义)。pushTime 变化由 engine 在 applyOps 内单独 rearm。
			const view = buildLiveSubViewSingle(sub, subRuntimeStore, globals);
			out.push({
				type: "update",
				uid: op.sub.uid,
				changes: [
					{
						scope: "live",
						live: view.live,
						liveEnd: view.liveEnd,
						liveGuardBuy: view.liveGuardBuy,
						superchat: view.superchat,
						wordcloud: view.wordcloud,
						liveSummary: view.liveSummary,
						minScPrice: view.minScPrice,
						minGuardLevel: view.minGuardLevel,
						pushTime: view.pushTime,
						restartPush: view.restartPush,
						aiOverride: view.aiOverride,
						customCardStyle: view.customCardStyle,
						customLiveMsg: view.customLiveMsg,
						customGuardBuy: view.customGuardBuy,
						customLiveSummary: view.customLiveSummary,
						customSpecialDanmakuUsers: view.customSpecialDanmakuUsers,
						customSpecialUsersEnterTheRoom: view.customSpecialUsersEnterTheRoom,
					},
				],
			});
		}
	}
	return out;
}

function listLiveRooms(live: LiveEngine): LiveListenerSnapshot[] {
	// Only rooms that have reported `liveStatus === true` via the WS dispatcher
	// surface to the Dashboard. Monitored-but-idle rooms are filtered so the
	// "正在直播" panel matches its name (vs. the looser "正在监听" set).
	return live
		.listLiveSnapshots()
		.filter((s) => s.isLive)
		.map((s) => ({
			uid: s.uid,
			roomId: s.roomId,
			isLive: s.isLive,
			title: s.title,
			cover: s.cover,
			areaName: s.areaName,
			startedAt: s.startedAt,
			viewers: s.viewers,
		}));
}
