import {
	type DevParamValues,
	fail,
	ok,
	type Result,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import type { OverridableApi } from "../../devtools/api-overrides.js";
import type { DevScenarioDef } from "../../devtools/registry.js";
import type { Api } from "../api/index.js";
import { failureFromBili } from "../error-codes.js";
import { CREATOR_PARAM, givenCreator, uidLabel } from "./live.js";
import { BILI_SHELLS_NOT_READY_SUMMARY } from "./shells.js";

/**
 * A3:四类动态(文字 / 图文 / 视频 / 专栏,外加转发)。
 *
 * 动态轮询每轮 cron 拉 `api.fetchAllDynamic()`,按作者 mid 认订阅、按 `pub_ts` 越过锚点就推。这里
 * 把一条假动态**并进**那个结果(真 feed 照拉、假的排最前),然后立刻让动态轮询跑一轮 —— 渲染、
 * 过滤、AI 点评、推送全是真链路,动态轮询分不出真假。跑完那一轮就把假的撤掉:锚点已经推过了,
 * 留着只是脏 feed。
 *
 * 假动态的 `pub_ts` 是「现在」:锚点因此推进到现在,一条**真的**、发布时间早于此刻但还没被
 * 拉到的动态会被跳过 —— 开发环境里可以接受,说明里写明。统计里也会记一条(它经过了
 * 作品装配入口、发了 `post-detected`),真机同样。
 */

/** 动态类型的四选 + 转发。 */
type Kind = "word" | "draw" | "av" | "article" | "forward";

export interface DynamicPollerLike {
	detectNow(): Promise<void>;
}

export interface DynamicScenarioDeps {
	/** B 站自己的名单(`ctx.subscriptions()` 那一份),现读;来源还没起来时是空的。 */
	roster: () => readonly SourceSubscriptionView[];
	/** 拉动态那一个盖板位;作者名经 `fetchUserCard` 现拉(名单里只有 UID)。 */
	api: () => OverridableApi<Pick<Api, "fetchAllDynamic" | "fetchUserCard">> | undefined;
	/** B 站自己的资料状态;假动态的作者头像与图集封面借它。 */
	profileAvatars: () => { avatarUrlOf(externalId: string): string | undefined } | undefined;
	/** 动态轮询是后建的,现取;还没起来就 undefined。 */
	dynamic: () => DynamicPollerLike | undefined;
}

/** 拉动态的结果(成功支铺着 `data`,失败支是标准码)与它成功时的 `data`。 */
type FeedResult = Awaited<ReturnType<Api["fetchAllDynamic"]>>;
type Feed = Extract<FeedResult, { ok: true }>["data"];
type FeedItem = Feed["items"][number];

const DEFAULT_TEXT = "devtools 造的一条动态:今天也要元气满满！";
/** 没头像时的兜底图(B 站默认头像)。封面 / 图集也用它 —— 得是一张真能拉到的图。 */
const FALLBACK_PIC = "https://i0.hdslb.com/bfs/face/member/noface.jpg";

interface FakeInput {
	id: string;
	kind: Kind;
	/** 作者:UID 与卡上的名字。 */
	author: { externalId: string; name: string };
	text: string;
	ts: number;
}

function richText(text: string) {
	return {
		text,
		rich_text_nodes: [{ type: "RICH_TEXT_NODE_TYPE_TEXT", text, orig_text: text }],
	};
}

/** 北京时间 `MM-dd HH:mm`,与接口的 `pub_time` 同形。 */
function pubTime(ts: number): string {
	const d = new Date(ts * 1000 + 8 * 3_600_000).toISOString();
	return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}

function author(who: FakeInput["author"], ts: number, pubAction: string, avatar: string) {
	return {
		face: avatar,
		following: true,
		jump_url: `https://space.bilibili.com/${who.externalId}/dynamic`,
		label: "",
		mid: Number(who.externalId),
		name: who.name,
		pub_action: pubAction,
		pub_action_text: pubAction,
		pub_location_text: "",
		pub_time: pubTime(ts),
		pub_ts: ts,
		type: "AUTHOR_TYPE_NORMAL",
		vip: { type: 0 },
	};
}

const ZERO_STAT = { comment: { count: 0 }, forward: { count: 0 }, like: { count: 0 } };

function buildFake(input: FakeInput, avatar: string): FeedItem {
	const { id, kind, author: who, text, ts } = input;
	const pic = avatar;
	const base = {
		basic: { comment_id_str: id, comment_type: 17, rid_str: id },
		id_str: id,
		visible: true,
	};
	switch (kind) {
		case "word":
			return {
				...base,
				type: "DYNAMIC_TYPE_WORD",
				modules: {
					module_author: author(who, ts, "", avatar),
					module_stat: ZERO_STAT,
					module_dynamic: { desc: richText(text) },
				},
			} as unknown as FeedItem;
		case "draw":
			return {
				...base,
				type: "DYNAMIC_TYPE_DRAW",
				modules: {
					module_author: author(who, ts, "", avatar),
					module_stat: ZERO_STAT,
					module_dynamic: {
						major: {
							type: "MAJOR_TYPE_OPUS",
							opus: {
								fold_action: [],
								jump_url: `https://www.bilibili.com/opus/${id.replace(/\D/g, "")}`,
								pics: [1, 2, 3].map(() => ({
									url: pic,
									width: 640,
									height: 640,
									size: 40,
									live_url: "",
								})),
								summary: richText(text),
								title: "",
							},
						},
					},
				},
			} as unknown as FeedItem;
		case "av":
			return {
				...base,
				type: "DYNAMIC_TYPE_AV",
				modules: {
					module_author: author(who, ts, "投稿了视频", avatar),
					module_stat: ZERO_STAT,
					module_dynamic: {
						desc: richText(text),
						major: {
							type: "MAJOR_TYPE_ARCHIVE",
							archive: {
								aid: "170001",
								bvid: "BV17x411w7KC",
								badge: { text: "投稿视频", bg_color: "#FB7299", color: "#FFFFFF" },
								cover: pic,
								desc: "devtools 造的一条视频投稿,封面借了头像。",
								disable_preview: 0,
								duration_text: "12:34",
								// 接口给的是**省协议**的地址(`//www.bilibili.com/...`),动态轮询照着拼 `https:` + 它。
								// 写成绝对地址会拼出 `https:https://…`,一条点不开的链接 —— 而链接正是这个场景
								// 要看的东西之一。
								jump_url: "//www.bilibili.com/video/BV17x411w7KC",
								stat: { play: "6.5万", danmaku: "1234" },
								title: `${who.name} 的新视频(devtools)`,
								type: 1,
							},
						},
					},
				},
			} as unknown as FeedItem;
		case "article":
			return {
				...base,
				type: "DYNAMIC_TYPE_ARTICLE",
				modules: {
					module_author: author(who, ts, "投稿了专栏", avatar),
					module_stat: ZERO_STAT,
					module_dynamic: {
						major: {
							type: "MAJOR_TYPE_OPUS",
							opus: {
								fold_action: [],
								jump_url: `https://www.bilibili.com/read/cv${id.replace(/\D/g, "")}`,
								pics: [{ url: pic, width: 640, height: 360, size: 40, live_url: "" }],
								summary: richText(text),
								title: `${who.name} 的新专栏(devtools)`,
							},
						},
					},
				},
			} as unknown as FeedItem;
		case "forward":
			return {
				...base,
				type: "DYNAMIC_TYPE_FORWARD",
				modules: {
					module_author: author(who, ts, "转发动态", avatar),
					module_stat: ZERO_STAT,
					module_dynamic: { desc: richText(text) },
				},
				orig: buildFake(
					{
						id: `${id}-orig`,
						kind: "word",
						author: who,
						text: "被转发的那条(devtools 造的)。",
						ts: ts - 3600,
					},
					avatar,
				),
			} as unknown as FeedItem;
	}
}

const EMPTY_FEED = (): Feed => ({
	has_more: false,
	items: [],
	offset: "",
	update_baseline: "",
	update_num: 0,
});

export function dynamicScenarios(deps: DynamicScenarioDeps): DevScenarioDef[] {
	/** 现在并在 feed 里的假动态。跑完那一轮就撤。 */
	const pending: FeedItem[] = [];
	let seq = 0;

	/** 让拉动态回错误码:还剩几次。用完置空。 */
	let failing: { code: number; remaining: number } | null = null;

	/**
	 * `fetchAllDynamic` 只有一个盖板位:假动态与错误码共用它,各自的状态变了都来这里对一次 ——
	 * 谁还要用就留着,都不用了才摘。错误码优先:真请求都不发(也就不打 B 站)。
	 */
	function syncOverride(api: OverridableApi<Pick<Api, "fetchAllDynamic">>): void {
		if (pending.length === 0 && failing === null) {
			api.clear("fetchAllDynamic");
			return;
		}
		api.override("fetchAllDynamic", async (real) => {
			if (failing) {
				const { code } = failing;
				failing.remaining -= 1;
				if (failing.remaining <= 0) failing = null;
				syncOverride(api);
				// 真接口出错时的样子:请求层把 B 站的码翻成的失败结果(同一个纯函数造),没有 data。
				return failureFromBili(code, `devtools:模拟的错误码 ${code}`);
			}
			// 真 feed 拉不到(没登录 / 风控)也照样造:用一份空底。动态轮询收到失败会走错误处理,
			// 那不是这次要看的东西。
			let feed: Feed;
			try {
				const result = await real();
				feed = result.ok && result.data ? result.data : EMPTY_FEED();
			} catch {
				feed = EMPTY_FEED();
			}
			return ok({ data: { ...feed, items: [...pending, ...feed.items] } });
		});
	}

	/**
	 * 给了 `creator` 就用它(宿主已按名单核过),省略取名单里第一个开着作品的;作品开关关着的人
	 * 不在动态轮询要推的人里,造了也被跳过,直接拒。
	 */
	function pickCreator(params: DevParamValues): Result<{ externalId: string }> {
		const roster = deps.roster();
		const given = givenCreator(params);
		if (given === undefined) {
			const first = roster.find((view) => view.features.has("post"));
			return first
				? ok({ externalId: first.externalId })
				: fail("invalid", "名单里没有一位开着作品的 UP");
		}
		const view = roster.find((one) => one.externalId === given);
		if (!view) return fail("invalid", `${uidLabel(given)} 不在 B 站的名单里`);
		if (!view.features.has("post")) {
			return fail("invalid", `${uidLabel(given)} 的作品开关关着,造了也会被动态轮询跳过`);
		}
		return ok({ externalId: given });
	}

	/** 卡上的作者名:经 B 站自己的接口现拉用户卡(名单里只有 UID);拉不到就用 UID。 */
	async function nameOf(
		api: OverridableApi<Pick<Api, "fetchUserCard">>,
		externalId: string,
	): Promise<string> {
		try {
			const card = await api.api.fetchUserCard(externalId);
			const name = card.ok ? card.data?.card?.name : undefined;
			if (typeof name === "string" && name.trim() !== "") return name;
		} catch {
			// 连不上 / 超时:照样造,名字退回 UID。
		}
		return uidLabel(externalId);
	}

	const post: DevScenarioDef = {
		id: "dynamic.post",
		group: "event",
		title: "发动态",
		icon: "dyn",
		desc: "往动态 feed 里并进一条这位 UP 的假动态(文字 / 图文 / 视频 / 专栏 / 转发),然后立刻跑一轮检测 —— 过滤、渲染、AI 点评、推送全是真链路。作者名现拉一次用户卡(拉不到就写 UID);锚点会推进到现在,统计里也会记一条。",
		quick: true,
		params: [
			CREATOR_PARAM,
			{
				key: "type",
				label: "类型",
				kind: "enum",
				options: [
					{ value: "word", label: "文字" },
					{ value: "draw", label: "图文(3 张图)" },
					{ value: "av", label: "视频投稿" },
					{ value: "article", label: "专栏" },
					{ value: "forward", label: "转发" },
				],
				default: "word",
			},
			{ key: "text", label: "正文", kind: "text", default: DEFAULT_TEXT },
		],
		async run(params) {
			const api = deps.api();
			if (!api) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			const engine = deps.dynamic();
			if (!engine)
				return fail(
					"invalid",
					"动态轮询还没起来(没登录,或动态那一格设置读不懂),这会儿造了也没人来捡",
				);
			const picked = pickCreator(params);
			if (!picked.ok) return picked;
			const { externalId } = picked;
			const kind = String(params.type ?? "word") as Kind;
			const name = await nameOf(api, externalId);
			seq += 1;
			const fake = buildFake(
				{
					id: `dev-${Date.now()}-${seq}`,
					kind,
					author: { externalId, name },
					text: typeof params.text === "string" && params.text !== "" ? params.text : DEFAULT_TEXT,
					ts: Math.floor(Date.now() / 1000),
				},
				deps.profileAvatars()?.avatarUrlOf(externalId) ?? FALLBACK_PIC,
			);
			pending.push(fake);
			syncOverride(api);
			try {
				await engine.detectNow();
			} finally {
				pending.splice(pending.indexOf(fake), 1);
				syncOverride(api);
			}
			return ok({ summary: `已替 ${name} 发了一条假动态(${kind}),检测已跑完一轮。` });
		},
	};

	const failScenario: DevScenarioDef = {
		id: "dynamic.fail",
		group: "state",
		title: "动态拉取报错",
		icon: "dyn",
		desc: "让下一轮(可选:之后连着 N 轮)拉动态的请求返回指定的错误码,看动态轮询的退避、问题表与私聊怎么反应。想立刻看到就再点「动态检测」。盖的只是拉动态这一个请求,不经请求客户端的拦截:回 -101 也不会把登录状态变成失效,只会让动态轮询停着,等登录恢复才重启。要拉起来就先按「登录失效」再按「重新确认登录」。收摊即回真。",
		params: [
			{ key: "code", label: "错误码", kind: "number", default: -352 },
			{ key: "rounds", label: "连着几轮", kind: "number", default: 1, min: 1, max: 50 },
		],
		run(params) {
			const api = deps.api();
			if (!api) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			const code = Number(params.code ?? -352);
			if (!Number.isInteger(code) || code === 0) {
				return fail("invalid", "错误码要是个非 0 的整数(0 是成功)");
			}
			const rounds = Number(params.rounds ?? 1);
			if (!Number.isInteger(rounds) || rounds < 1) {
				return fail("invalid", "轮数要是个不小于 1 的整数");
			}
			failing = { code, remaining: rounds };
			syncOverride(api);
			return ok({ summary: `接下来 ${failing.remaining} 轮拉动态会回错误码 ${code}。` });
		},
		active() {
			if (!failing) return null;
			return {
				scenarioId: "dynamic.fail",
				label: `拉动态 → 错误码 ${failing.code}(还剩 ${failing.remaining} 轮)`,
			};
		},
		reset() {
			if (!failing) return;
			failing = null;
			const api = deps.api();
			if (api) syncOverride(api);
		},
	};

	return [post, failScenario];
}
