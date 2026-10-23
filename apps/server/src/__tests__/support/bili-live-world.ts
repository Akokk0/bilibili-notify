/**
 * B 站直播端到端测试的世界:**真的** `createEngines`(真直播引擎、真监听管理、真房间会话、真推送层、真派发器、
 * 真事件总线、真分层上报器、真服务上下文),假件只有四样 —— 假的 B 站接口对象、假的弹幕连接(帧由真的编解码器
 * 编出来喂进去)、假的出图器(只记入参、交一串认得出的字节)、假的平台适配器(把交出去的载荷按序记下来)。
 *
 * 用例只经这里交回的几个口说话(喂帧、拨房间状态、推时间、读推出去的 / 总线上的 / 问题表里的),不碰引擎里的任何
 * 对象。3b 后面几片把直播装配抽走、把两套场次引擎合成一套时,要改的是这个文件里「怎么把世界搭起来」,用例里的
 * 期望不该动 —— 动了就是行为变了。
 *
 * **先 `vi.useFakeTimers()` 再建世界**:弹幕客户端的心跳与建连限时用的是全局定时器,晚了就假不到。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageRenderer } from "@bilibili-notify/image";
import {
	type Connection,
	EXTRA_KEYS,
	type ExtraKey,
	FEATURE_KEYS,
	type FeatureKey,
	type Identity,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type NotificationPayload,
	ok,
	type PayloadSegment,
	type PlatformAdapter,
	type PushTarget,
	type SourceAuth,
	type SpecialViewer,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import { z } from "zod";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import type { Api } from "../../bilibili/api/index.js";
import { encodePacket, WsOp } from "../../bilibili/live/protocol/codec.js";
import { makeRecordingLayers } from "../../bilibili/live/session/__tests__/support/live-problems.js";
import { createBiliSource } from "../../bilibili/source.js";
import type { ConfigStore } from "../../config/store.js";
import { openIntegration } from "../../integrations/open.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createLiveTable } from "../../live/live-table.js";
import { createProblemTable } from "../../problems/problem-table.js";
import { createEngines } from "../../runtime/engines.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createNodeServiceContext } from "../../runtime/service-context.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import { fixedLocale } from "../support/fixed-locale.js";
import { memoryKeyValueStores, memoryStoreHandle } from "../support/memory-key-value-store.js";
import { registryOf } from "./adapter-ctx.js";
import { snapshotFor } from "./connection-snapshot.js";

/** 这个世界里唯一的那位 UP、他的房间、他的订阅与推送目标。 */
export const BILI_LIVE_UID = "10001";
const BILI_LIVE_ROOM_ID = "5001";
export const BILI_LIVE_SUBSCRIPTION_ID = "sub-live";
export const BILI_LIVE_TARGET_ID = "target-group";
/** 开了 `secondTarget` 才有的第二个推送目标(另一个群)。 */
export const BILI_LIVE_SECOND_TARGET_ID = "target-group-b";
const TARGET_ID = BILI_LIVE_TARGET_ID;
const SECOND_TARGET_ID = BILI_LIVE_SECOND_TARGET_ID;
const CONNECTION_ID = "connection-bot";

/** 世界开始的那一刻:2026-03-01 12:00:00(北京时间)。B 站的 `live_time` 恒为北京时间。 */
export const BILI_LIVE_EPOCH = "2026-03-01T04:00:00.000Z";

/** 假抓图服务交回的图库引用(恒这一个)。 */
const FETCHED_IMAGE_REF = `${"a".repeat(64)}.webp`;
/** 世界的图库里各档大航海徽章共用的那一张;读图口只认得它,读回的字节是「徽章」。 */
export const BILI_LIVE_GUARD_BADGE_REF = `${"f".repeat(64)}.png`;

/** 服务器下行的心跳回执:16 字节头 + 4 字节人气值(`encodePacket` 只编 JSON 体,这一帧手拼)。 */
function heartbeatReply(): Uint8Array {
	const packet = new Uint8Array(20);
	const view = new DataView(packet.buffer);
	view.setUint32(0, 20);
	view.setUint16(4, 16);
	view.setUint16(6, 1);
	view.setUint32(8, WsOp.HeartbeatReply);
	view.setUint32(12, 1);
	view.setUint32(16, 1);
	return packet;
}

/** 推出去的一段 → 一眼认得出的字。图片印它的字节(假出图器交的是「卡种#第几张」)。 */
function describeSegment(segment: PayloadSegment): string {
	switch (segment.kind) {
		case "text":
			return segment.text;
		case "image":
			return `[图 ${segment.buffer.toString()}]`;
		case "link":
			return `[链接 ${segment.href}]`;
		case "at-all":
			return "[@全体]";
		default:
			return `[${JSON.stringify(segment)}]`;
	}
}

/** 推出去的一条载荷 → 字面量好写的形状:纯文字是一个串,几段拼成的是一个数组。 */
function describePayload(payload: NotificationPayload): string | string[] {
	switch (payload.kind) {
		case "text":
			return payload.text;
		case "image":
			return `[图 ${payload.image.buffer.toString()}]`;
		case "composite":
			return payload.segments.map(describeSegment);
		default:
			return `[${payload.kind}]`;
	}
}

/**
 * 建世界并等它监听上。设置一律**明写**(不吃出厂默认值,默认值之后会改):特性开关与附加项不给就是关,
 * 文案是写死在这里的那几句。
 */
export async function bootBiliLiveWorld(
	opts: {
		/** 开着的特性(不给 = 全关;全关时直播间不会被监听)。 */
		features?: FeatureKey[];
		/** 开着的附加项(不给 = 全关)。 */
		extras?: ExtraKey[];
		/** 断流接续(分钟);不给 = 关。 */
		liveEndGraceMinutes?: number;
		/** 周期「正在直播」的间隔(小时)。 */
		streamingIntervalHours?: number;
		/** 醒目留言的金额门槛(元)。 */
		minSuperchatAmount?: number;
		/** 上舰用自定义文案(全局那份开着)。 */
		guardTemplate?: boolean;
		/** 特别关注名单。 */
		specialViewers?: SpecialViewer[];
		/** 有没有出图器;不给 = 有。 */
		renderer?: boolean;
		/** 第二个推送目标(另一个群):每个特性都路由到两个目标;不给 = 只有一个。 */
		secondTarget?: boolean;
		/** AI 总开关开着、挂一个假的 AI 点评(`comment` 按提示词回字);不给 = AI 没开、没有服务商。 */
		commentary?: (prompt: string) => Promise<string>;
	} = {},
) {
	const globals = makeDefaultGlobalConfig();
	const on = new Set<string>([...(opts.features ?? []), ...(opts.extras ?? [])]);
	for (const key of FEATURE_KEYS) globals.defaults.features[key] = on.has(key);
	for (const key of EXTRA_KEYS) globals.defaults.features.extras[key] = on.has(key);
	globals.defaults.schedule = {
		quietHours: [],
		liveEndGrace: opts.liveEndGraceMinutes !== undefined,
		liveEndGraceMinutes: opts.liveEndGraceMinutes ?? 2,
	};
	globals.defaults.liveStart.catchUpOnBoot = false;
	globals.defaults.liveStreaming.streamingIntervalHours = opts.streamingIntervalHours ?? 1;
	globals.defaults.superchat = {
		...(opts.minSuperchatAmount === undefined ? {} : { minAmount: opts.minSuperchatAmount }),
	};
	globals.defaults.cards.enabled = true;
	// 在建世界之前开:直播引擎的配置快照在构造时取。
	if (opts.commentary) globals.ai.enabled = true;
	// 今天的出厂文案,照抄在这里钉死(3b-21 改占位符写法时这几句跟着改)。
	Object.assign(globals.defaults.templates, {
		liveStart: "{name} 开播啦，当前粉丝数：{follower}",
		liveStreaming: "{name} 正在直播，已播 {time}，累计观看：{watched}",
		liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
		liveSummary: "共 {dmc} 位{fanclub}发了 {dca} 条弹幕，第一名 {un1}（{dc1} 条）",
		viewerChat: "{name} 的关注用户 {viewer} 发送弹幕：{msg}",
		viewerEnter: "{viewer} 进入了 {name} 的直播间",
	});
	globals.defaults.templates.membership.guard = {
		enabled: opts.guardTemplate === true,
		default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
		tiers: {},
	};

	const subscription = makeEmptySubscription({
		id: BILI_LIVE_SUBSCRIPTION_ID,
		identity: { sourceKey: "bilibili", externalId: BILI_LIVE_UID },
	});
	for (const key of FEATURE_KEYS) {
		subscription.routing[key] = opts.secondTarget ? [TARGET_ID, SECOND_TARGET_ID] : [TARGET_ID];
	}
	subscription.specialViewers = opts.specialViewers ?? [];
	const subscriptions = [subscription];

	// ---- 假的 B 站:房间与主播此刻的样子由用例拨 ----
	const bili = {
		/** 0 没播 / 1 在播 / 2 轮播。 */
		liveStatus: 0,
		/** 北京时间,「yyyy-MM-dd HH:mm:ss」。 */
		liveTime: "0000-00-00 00:00:00",
		followers: 1000,
		online: 321,
		/** 取房间信息:正常 / 抛错 / 回一个空壳(没有 uid)。 */
		roomInfo: "ok" as "ok" | "throws" | "empty",
		/** 取主播信息:正常 / 抛错。 */
		masterInfo: "ok" as "ok" | "throws",
		/** 上舰观众的头像地址(空串 = 接口没给)。 */
		viewerFace: "https://i0.hdslb.com/bfs/face/viewer.jpg",
	};

	// ---- 假的弹幕连接 ----
	const sockets: Array<{
		closed: boolean;
		fire: (event: string, ...args: unknown[]) => void;
	}> = [];
	const openDanmakuSocket = () => {
		const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
		const fire = (event: string, ...args: unknown[]): void => {
			for (const fn of handlers.get(event) ?? []) fn(...args);
		};
		const entry = { closed: false, fire };
		sockets.push(entry);
		// 客户端拿到 socket 之后才挂监听,所以握手排到这一拍之后:连上、认证通过。
		queueMicrotask(() => {
			fire("open");
			fire("message", encodePacket(WsOp.AuthReply, { code: 0 }));
		});
		return {
			binaryType: "",
			on(event: string, fn: (...args: unknown[]) => void) {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			},
			send(data: Uint8Array) {
				// 客户端每 30 秒一次心跳,服务器回一帧 —— 没有它,推几个小时的用例会被 3 分钟的静默看门狗拉去重连。
				const op = new DataView(data.buffer, data.byteOffset).getUint32(8);
				if (op === WsOp.Heartbeat && !entry.closed) fire("message", heartbeatReply());
			},
			close() {
				entry.closed = true;
			},
		};
	};

	const api = {
		fetchLiveRoomInfoStreamKey: async () =>
			ok({
				data: { token: "test-token", host_list: [{ host: "danmaku.test", wss_port: 443 }] },
			}),
		getMyselfInfoCached: async () => ({ code: 0, data: { mid: 1, uname: "bot", face: "" } }),
		getBuvid3: async () => "test-buvid",
		openDanmakuSocket,
		fetchLiveRoomInfo: async () => {
			if (bili.roomInfo === "throws") throw new Error("取房间信息炸了");
			if (bili.roomInfo === "empty") return { code: 0, data: {} };
			return {
				code: 0,
				data: {
					uid: Number(BILI_LIVE_UID),
					room_id: Number(BILI_LIVE_ROOM_ID),
					short_id: 0,
					live_status: bili.liveStatus,
					live_time: bili.liveTime,
					title: "今天也来播一会儿",
					user_cover: "https://i0.hdslb.com/bfs/live/room-cover.jpg",
					keyframe: "https://i0.hdslb.com/bfs/live/keyframe.jpg",
					tags: "",
					area_name: "聊天",
					parent_area_name: "娱乐",
					description: "<p>房间简介</p>",
					online: bili.online,
				},
			};
		},
		getMasterInfo: async () => {
			if (bili.masterInfo === "throws") throw new Error("取主播信息炸了");
			return {
				code: 0,
				data: {
					info: { uid: Number(BILI_LIVE_UID), uname: "测试主播", face: "", gender: 0 },
					follower_num: bili.followers,
					room_id: Number(BILI_LIVE_ROOM_ID),
					medal_name: "测试牌",
				},
			};
		},
		fetchUserInfoInLive: async () => ok({ data: { face: bili.viewerFace } }),
	};

	// ---- 假的出图器:只记入参 ----
	const cards: Array<{ kind: string; input: unknown; options: unknown }> = [];
	const card = (kind: string, input: unknown, options: unknown): Buffer => {
		cards.push({ kind, input, options });
		return Buffer.from(`${kind}#${cards.filter((c) => c.kind === kind).length}`);
	};
	const renderer = {
		generateLiveCard: async (input: unknown, options: unknown) => card("直播卡", input, options),
		generateSuperchatCard: async (input: unknown, options: unknown) =>
			card("醒目留言卡", input, options),
		generateMembershipCard: async (input: unknown, options: unknown) =>
			card("上舰卡", input, options),
		generateWordCloudImg: async (words: unknown, name: unknown) =>
			card("词云", { words, name }, undefined),
	} as unknown as ImageRenderer;

	// ---- 假的平台:交出去的载荷按序记下来 ----
	const sent: Array<string | string[]> = [];
	/** 同 `sent`,多记一格送给了哪个目标(按目的地的 `address` 认)。 */
	const sentTo: Array<{ targetId: string; payload: string | string[] }> = [];
	const adapter: PlatformAdapter = {
		adapterKey: "onebot",
		settingsSchema: z.unknown(),
		isAvailable: () => true,
		send: async (_connection, destination, payload) => {
			const described = describePayload(payload);
			sent.push(described);
			const address = (destination as { address?: string }).address;
			sentTo.push({
				targetId: address === SECOND_TARGET_ID ? SECOND_TARGET_ID : TARGET_ID,
				payload: described,
			});
			return { ok: true, latencyMs: 1 };
		},
		probe: async () => ({ ok: true, latencyMs: 1 }),
		listConnectionCandidates: async () => [],
		start() {},
		stop() {},
	};
	const connection = {
		id: CONNECTION_ID,
		name: "bot",
		enabled: true,
		adapterKey: "onebot",
		platform: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		settings: {},
	} as unknown as Connection;
	const target = {
		id: TARGET_ID,
		name: "群",
		scope: "group",
		enabled: true,
		address: TARGET_ID,
		connectionId: CONNECTION_ID,
	} as unknown as PushTarget;
	const secondTarget = {
		...target,
		id: SECOND_TARGET_ID,
		name: "群乙",
		address: SECOND_TARGET_ID,
	} as unknown as PushTarget;
	const targets = opts.secondTarget ? [target, secondTarget] : [target];

	const bus = createNodeMessageBus();
	const events: Array<[string, unknown]> = [];
	for (const name of ["live-session-changed", "live-viewers-changed", "engine-error"] as const) {
		bus.on(name, (payload) => void events.push([name, payload]));
	}

	const serviceCtx = createNodeServiceContext({ name: "test", level: "silent", pretty: false });
	const recording = makeRecordingLayers();
	const fetchedImages: string[] = [];
	const biliState = memoryKeyValueStores("state", {
		[`room:${BILI_LIVE_UID}`]: BILI_LIVE_ROOM_ID,
	}).store;
	const sources = createSourceRegistry();
	const problemTable = createProblemTable({ logger: serviceCtx.logger });
	let runtimeRecord: {
		cachedProfile?: {
			name: string;
			sign: string;
			fans: number;
			lastRefreshedAt: string;
			fanClubName?: string;
		};
	} = {
		cachedProfile: {
			name: "测试主播",
			sign: "",
			fans: 1000,
			lastRefreshedAt: "2026-03-01T00:00:00.000Z",
			// 直播卡从核心资料缓存读粉丝牌名;这里预置成主播接口会交的同一个值。
			fanClubName: "测试牌",
		},
	};
	const subRuntime = {
		get: () => structuredClone(runtimeRecord),
		getAll: () => ({}),
		patch: async (_id: string, partial: typeof runtimeRecord) => {
			runtimeRecord = { ...runtimeRecord, ...structuredClone(partial) };
		},
		prune: async () => {},
		load: async () => {},
	};
	const sourceAuth: SourceAuth = {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => ({ status: "logged-in", loggedInAt: "2026-03-01T00:00:00.000Z" }),
		onChange: () => ({ dispose() {} }),
	};
	const liveTable = createLiveTable({ bus });
	const runtime = createEngines({
		serviceCtx,
		dataRoot: join(tmpdir(), "bn-bili-live-e2e-no-such-dir"),
		loadFontFace: async () => "",
		api: api as unknown as Api,
		// 未登录:开机那一轮关注同步不跑(与直播无关,省得假接口再长一个口)。
		auth: { state: () => ({ status: "logged-out" }) },
		configStore: {
			// 真的配置仓每次给一份深拷贝;引擎靠「上一份 vs 这一份」diff 出改了哪段,同一个引用的话改设置就看不出变化。
			getGlobals: () => structuredClone(globals),
			patchGlobals: async () => {},
			onChange: () => ({ dispose() {} }),
			getTargets: () => targets,
			getConnections: () => [connection],
			getConnection: (id: string) => [connection].find((c) => c.id === id),
			recordTargetReachability: async () => {},
			recordConnectionProbeState: async () => {},
		} as unknown as ConfigStore,
		historyStore: { record: async () => {} } as never,
		subscriptionStore: {
			list: () => subscriptions,
			findById: (id: string) => subscriptions.find((s) => s.id === id),
			findByIdentity: (identity: Identity) =>
				subscriptions.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
			listByIdentity: (identity: Identity) =>
				subscriptions.filter((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		} as never,
		subRuntimeStore: subRuntime as never,
		sources,
		linkResolvers: createLinkResolverRegistry(),
		aiToolProviders: createAiToolProviderRegistry(),
		problems: problemTable,
		bus,
		liveTable,
		adapters: registryOf([adapter]),
		imageFetcher: {
			fetchImage: async (url: string) => {
				fetchedImages.push(url);
				return ok({ ref: FETCHED_IMAGE_REF });
			},
		},
		readImage: async (ref: string) =>
			ref === BILI_LIVE_GUARD_BADGE_REF
				? { bytes: Buffer.from("徽章"), mime: "image/png" }
				: undefined,
		puppeteer: null,
	});
	if (opts.renderer !== false) runtime.setImageRenderer(renderer);
	// 世界里没有服务商,`createEngines` 自己建出的是 null:假的 AI 点评手动挂上。
	if (opts.commentary) {
		runtime.setCommentary({
			comment: opts.commentary,
		} as unknown as Parameters<typeof runtime.setCommentary>[0]);
	}
	const stores = memoryStoreHandle();
	const integration = await openIntegration({
		stores: stores.handle,
		logger: serviceCtx.forSubsystem("bilibili", "bilibili").logger,
		stopReason: "测试关停",
		problems: problemTable,
		reporter: "bilibili",
		label: () => "B 站",
		rejectedProblemLevel: "error",
		settings: {
			settings: (schema) => ({
				get: () => ok({ settings: schema.parse({}) }),
				onChange: () => ({ dispose() {} }),
			}),
			dispose() {},
		},
		httpOptions: { setTimeout: (fn, ms) => serviceCtx.setTimeout(fn, ms) },
		transitImages: {
			put: async () => ok({ ref: FETCHED_IMAGE_REF }),
		},
	});
	const source = createBiliSource({
		api: api as unknown as Api,
		bus,
		setTimeout: (fn, ms) => serviceCtx.setTimeout(fn, ms),
		auth: sourceAuth,
		problems: recording.layers,
		loginCheck: { setHealthCheckMs: () => {} },
		locale: fixedLocale(),
		liveContext: serviceCtx.forSubsystem("live", "bilibili"),
	});
	await runtime.registerSource({
		sourceKey: "bilibili",
		source,
		integration: {
			...integration.handle.ctx,
			state: biliState,
			fetchImage: async (url, _options) => {
				fetchedImages.push(url);
				return ok({
					ref: url.includes("/live-pay-mono/relation/")
						? BILI_LIVE_GUARD_BADGE_REF
						: FETCHED_IMAGE_REF,
				});
			},
		},
		logger: serviceCtx.forSubsystem("dynamic", "bilibili").logger,
	});

	/** 让在途的异步都落定(不推时间)。 */
	const settle = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
	};
	await settle();
	// 来源启动时预抓的三张官方档位徽章已经进了描述符；用例只关心这一场随后抓的图。
	fetchedImages.length = 0;

	return {
		bili,
		/** 推出去的载荷,按送达次序。 */
		sent,
		/** 同 `sent`,多记一格送给了哪个目标。 */
		sentTo,
		/** 世界的全局设置(可变;读口现取,建好之后改也生效)。 */
		globals,
		/** 把一个推送目标从目标表里删掉(订阅的路由不动,就像面板删目标后的样子)。 */
		removeTarget(id: string): void {
			const at = targets.findIndex((t) => t.id === id);
			if (at >= 0) targets.splice(at, 1);
		},
		/** 交给出图器的入参,按出卡次序。 */
		cards,
		/** 总线上的直播事件(`live-session-changed` / `live-viewers-changed` / `engine-error`),按发出次序。 */
		events,
		/** 抓进图库的图的地址。 */
		fetchedImages,
		/** 问题表里此刻的条目(订阅级的带 `uid:` 前缀)。 */
		problems: () =>
			problemTable
				.list()
				.map((problem) => {
					const subscriptionId =
						problem.about && "subscriptionId" in problem.about
							? problem.about.subscriptionId
							: undefined;
					const sub = subscriptionId
						? subscriptions.find((candidate) => candidate.id === subscriptionId)
						: undefined;
					return sub ? `${subscriptionIdentityOf(sub).externalId}:${problem.code}` : problem.code;
				})
				.sort(),
		/** 面板「正在直播」那一栏此刻列着的订阅 id。 */
		liveNow: () => liveTable.list().map((row) => row.subscriptionId),
		/** 建过几条弹幕连接、此刻还开着几条。 */
		connections: () => ({
			opened: sockets.length,
			open: sockets.filter((s) => !s.closed).length,
		}),
		/** 服务器发来一帧业务消息(`{ cmd: … }`),用真的编解码器编好,喂给最新那条连接。 */
		async frame(command: object): Promise<void> {
			sockets.at(-1)?.fire("message", encodePacket(WsOp.Message, command));
			await settle();
		},
		/** 改全局默认里的一把特性开关,并像配置仓那样发 `config-changed`(globals)。 */
		async setGlobalFeature(key: FeatureKey, on: boolean): Promise<void> {
			globals.defaults.features[key] = on;
			bus.emit("config-changed", { scope: "globals" });
			await settle();
		},
		/** 改这条订阅自己覆盖的一把特性开关,并像订阅仓那样发 `subscription-changed`(update)。 */
		async setSubscriptionFeature(key: FeatureKey, on: boolean): Promise<void> {
			subscription.overrides = {
				...subscription.overrides,
				features: { ...subscription.overrides.features, [key]: on },
			};
			bus.emit("subscription-changed", { ops: [{ kind: "update", sub: subscription }] });
			await settle();
		},
		/** 时间往前走。 */
		async advance(ms: number): Promise<void> {
			await vi.advanceTimersByTimeAsync(ms);
			await settle();
		},
		/** B 站那头开播了(房间接口从此回在播),`liveTime` 是北京时间。不发帧。 */
		goLive(liveTime: string): void {
			bili.liveStatus = 1;
			bili.liveTime = liveTime;
		},
		setFans(value: number): void {
			if (!runtimeRecord.cachedProfile) return;
			runtimeRecord = {
				...runtimeRecord,
				cachedProfile: { ...runtimeRecord.cachedProfile, fans: value },
			};
		},
		/** B 站那头下播了(房间接口从此回没播,开播时刻也清成 B 站对没播的房间给的那串零)。不发帧。 */
		goOffline(): void {
			bili.liveStatus = 0;
			bili.liveTime = "0000-00-00 00:00:00";
		},
		async close(): Promise<void> {
			runtime.dispose();
			await integration.handle.dispose();
			stores.handle.close();
			await serviceCtx.dispose();
		},
	};
}
