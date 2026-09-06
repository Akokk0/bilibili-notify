import type { BilibiliAPI } from "@bilibili-notify/api";
import type { DevParamValues } from "@bilibili-notify/contract";
import type { OverridableApi } from "../api-overrides.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";
import type { SubPick } from "./live.js";

/**
 * A3:四类动态(文字 / 图文 / 视频 / 专栏,外加转发)。
 *
 * 引擎每轮 cron 拉 `api.getAllDynamic()`,按作者 mid 认订阅、按 `pub_ts` 越过锚点就推。这里
 * 把一条假动态**并进**那个结果(真 feed 照拉、假的排最前),然后立刻让引擎跑一轮 —— 渲染、
 * 过滤、AI 点评、推送全是真链路,引擎分不出真假。跑完那一轮就把假的撤掉:锚点已经推过了,
 * 留着只是脏 feed。
 *
 * 假动态的 `pub_ts` 是「现在」:锚点因此推进到现在,一条**真的**、发布时间早于此刻但还没被
 * 拉到的动态会被跳过 —— 开发环境里可以接受,说明里写明。统计里也会记一条(它经过了
 * `dynamic-detected`),真机同样。
 */

/** 动态类型的四选 + 转发。 */
type Kind = "word" | "draw" | "av" | "article" | "forward";

export interface DynamicEngineLike {
	detectNow(): Promise<void>;
}

export interface DynamicScenarioDeps {
	subs: () => SubPick[];
	api: OverridableApi<Pick<BilibiliAPI, "getAllDynamic">>;
	/** 引擎是后建的,现取;还没起来就 undefined。 */
	dynamic: () => DynamicEngineLike | undefined;
}

type Feed = Awaited<ReturnType<BilibiliAPI["getAllDynamic"]>>;
type FeedItem = Feed["data"]["items"][number];

const DEFAULT_TEXT = "devtools 造的一条动态:今天也要元气满满！";
/** 没头像时的兜底图(B 站默认头像)。封面 / 图集也用它 —— 得是一张真能拉到的图。 */
const FALLBACK_PIC = "https://i0.hdslb.com/bfs/face/member/noface.jpg";

interface FakeInput {
	id: string;
	kind: Kind;
	sub: SubPick;
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

function author(sub: SubPick, ts: number, pubAction: string) {
	return {
		face: sub.avatar ?? FALLBACK_PIC,
		following: true,
		jump_url: `https://space.bilibili.com/${sub.uid}/dynamic`,
		label: "",
		mid: Number(sub.uid),
		name: sub.name,
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

function buildFake(input: FakeInput): FeedItem {
	const { id, kind, sub, text, ts } = input;
	const pic = sub.avatar ?? FALLBACK_PIC;
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
					module_author: author(sub, ts, ""),
					module_stat: ZERO_STAT,
					module_dynamic: { desc: richText(text) },
				},
			} as unknown as FeedItem;
		case "draw":
			return {
				...base,
				type: "DYNAMIC_TYPE_DRAW",
				modules: {
					module_author: author(sub, ts, ""),
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
					module_author: author(sub, ts, "投稿了视频"),
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
								// 接口给的是**省协议**的地址(`//www.bilibili.com/...`),引擎照着拼 `https:` + 它。
								// 写成绝对地址会拼出 `https:https://…`,一条点不开的链接 —— 而链接正是这个场景
								// 要看的东西之一。
								jump_url: "//www.bilibili.com/video/BV17x411w7KC",
								stat: { play: "6.5万", danmaku: "1234" },
								title: `${sub.name} 的新视频(devtools)`,
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
					module_author: author(sub, ts, "投稿了专栏"),
					module_stat: ZERO_STAT,
					module_dynamic: {
						major: {
							type: "MAJOR_TYPE_OPUS",
							opus: {
								fold_action: [],
								jump_url: `https://www.bilibili.com/read/cv${id.replace(/\D/g, "")}`,
								pics: [{ url: pic, width: 640, height: 360, size: 40, live_url: "" }],
								summary: richText(text),
								title: `${sub.name} 的新专栏(devtools)`,
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
					module_author: author(sub, ts, "转发动态"),
					module_stat: ZERO_STAT,
					module_dynamic: { desc: richText(text) },
				},
				orig: buildFake({
					id: `${id}-orig`,
					kind: "word",
					sub,
					text: "被转发的那条(devtools 造的)。",
					ts: ts - 3600,
				}),
			} as unknown as FeedItem;
	}
}

const EMPTY_FEED = (): Feed =>
	({
		code: 0,
		message: "ok",
		data: { has_more: false, items: [], offset: "", update_baseline: "", update_num: 0 },
	}) as Feed;

export function dynamicScenarios(deps: DynamicScenarioDeps): DevScenarioDef[] {
	/** 现在并在 feed 里的假动态。跑完那一轮就撤。 */
	const pending: FeedItem[] = [];
	let seq = 0;

	function syncOverride(): void {
		if (pending.length === 0) {
			deps.api.clear("getAllDynamic");
			return;
		}
		deps.api.override("getAllDynamic", async (real) => {
			// 真 feed 拉不到(没登录 / 风控)也照样造:用一份空底。引擎收到 code≠0 会走错误处理,
			// 那不是这次要看的东西。
			let feed: Feed;
			try {
				feed = await real();
			} catch {
				feed = EMPTY_FEED();
			}
			if (feed.code !== 0 || !feed.data) feed = EMPTY_FEED();
			return { ...feed, data: { ...feed.data, items: [...pending, ...feed.data.items] } };
		});
	}

	function pickSub(params: DevParamValues): SubPick {
		const wanted = params.sub;
		const subs = deps.subs();
		const sub =
			wanted === undefined
				? subs.find((s) => s.enabled)
				: subs.find((s) => s.id === String(wanted));
		if (!sub) {
			throw new DevParamError(wanted === undefined ? "没有启用的订阅" : `没有这个订阅:${wanted}`);
		}
		return sub;
	}

	const post: DevScenarioDef = {
		id: "dynamic.post",
		group: "event",
		title: "发动态",
		icon: "dyn",
		desc: "往动态 feed 里并进一条这位 UP 的假动态(文字 / 图文 / 视频 / 专栏 / 转发),然后立刻跑一轮检测 —— 过滤、渲染、AI 点评、推送全是真链路。锚点会推进到现在,统计里也会记一条。",
		quick: true,
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
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
			const sub = pickSub(params);
			const engine = deps.dynamic();
			if (!engine) throw new DevParamError("动态引擎还没起来(没登录?),这会儿造了也没人来捡");
			const kind = String(params.type ?? "word") as Kind;
			seq += 1;
			const fake = buildFake({
				id: `dev-${Date.now()}-${seq}`,
				kind,
				sub,
				text: typeof params.text === "string" && params.text !== "" ? params.text : DEFAULT_TEXT,
				ts: Math.floor(Date.now() / 1000),
			});
			pending.push(fake);
			syncOverride();
			try {
				await engine.detectNow();
			} finally {
				pending.splice(pending.indexOf(fake), 1);
				syncOverride();
			}
			return { summary: `已替 ${sub.name} 发了一条假动态(${kind}),检测已跑完一轮。` };
		},
	};

	return [post];
}
