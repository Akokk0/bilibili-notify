/**
 * 「假装一条桥连上来」—— 把「验桥」从「必须先写插件」解绑。
 *
 * 没有真插件时,拓展页上那条桥接入永远是灰的:能力矩阵、状态面板、bot 名单、失败提示
 * 一格都看不见。这两条场景拿那条接入自己的 token 连一条**真 socket** 回桥自己的端点,于是
 * upgrade、鉴权、握手、`publishView`、推送 adapter、回执全是真的 —— 假的只有
 * 「后面没有 bot」这一件。连上之后推送目标页「新建连接」里就挑得到那个假 bot。
 *
 * 🔴 **这是「真动作」还是「假状态」?** —— 是**假状态**:连着的这条是 devtools 造出来的,
 * 面板上那条卡因它变绿。所以它进「当前生效」条、也归一键收摊(见 `devtools.md` 那条
 * 「假状态只由 devtools 收摊」)。反过来,它带来的推送**是真的发生过**的:历史里那行、
 * 失败提示那句都不清 —— 那是真动作。
 *
 * 场景 id 写不带前缀的(`connect` / `inbound`),宿主加 `bridge.`;`active().scenarioId` 同样不带。
 * 开发入口**只用** `ctx.mountUrl()` 找到自己的端点,不读主人身份与指令前缀:私聊与群消息的
 * 发信人是面板里可填的一格,默认一个编出来的假号。
 */

import {
	type DevScenarioDef,
	type ExtensionDevtoolsContext,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import {
	BRIDGE_CAPABILITIES,
	type BridgeBotWire,
	type BridgeCapability,
	type BridgeCapabilityState,
} from "../contract.js";
import { type BridgeLink, BridgeSettingsSchema } from "../settings.js";
import { createFakeBridge, type FakeBridge } from "./fake-bridge.js";

const CAP_PRESETS = [
	{ value: "mixed", label: "三态齐全(看矩阵)" },
	{ value: "all", label: "全都支持" },
	{ value: "none", label: "全都不支持" },
] as const;

function everyCap(state: BridgeCapabilityState): Record<BridgeCapability, BridgeCapabilityState> {
	return Object.fromEntries(BRIDGE_CAPABILITIES.map((cap) => [cap, state])) as Record<
		BridgeCapability,
		BridgeCapabilityState
	>;
}

/**
 * 六项能力(见协议 §7)。`mixed` 那一档**刻意把三态凑齐**:「还不知道」在真环境里最难
 * 凑出来,而它恰恰是面板上最容易被误读成「不支持」的一格 —— 所以只有它逐项写死。
 */
function capabilitiesOf(preset: string): Record<BridgeCapability, BridgeCapabilityState> {
	if (preset === "all") return everyCap("supported");
	if (preset === "none") return everyCap("unsupported");
	return {
		atAll: "supported",
		inbound: "supported",
		forward: "supported",
		miniAppCard: "unsupported",
		markdown: "unsupported",
		shareCardLinks: "unknown",
	};
}

const SCOPES = [
	{ value: "private", label: "私聊(试指令)" },
	{ value: "group", label: "群消息(试链接解析)" },
] as const;

const DEFAULT_GROUP_TEXT = "看看这个 https://www.bilibili.com/video/BV1GJ411x7h7";

/** 假 bot 自己的号 —— 面板上那一行显示它,归一化那头拿它当「这是机器人自己」的判据。 */
const FAKE_BOT_SELF_ID = "900400001";

/**
 * 「发信人」一格的默认值 —— 编出来的假号,私聊与群消息都用它。
 *
 * 🔴 **不许等于 {@link FAKE_BOT_SELF_ID}**:链接解析有一道「机器人自己贴的链接不解析」的闸,
 * 撞上了整条消息会被静默吃掉 —— 场景报「已驮上去」,面板上什么都不发生,日志里一个字都没有。
 */
const DEFAULT_SENDER = "800100002";

/** 「群号」一格的默认值 —— 同样是编出来的假号,风格与上面那个一致。 */
const DEFAULT_GROUP_ID = "700100003";

/**
 * 假 bot 的平台图标(协议 1.2)。只能是 `data:image/…;base64,` 的 data URL —— BN 不收
 * http 地址,面板每次打开都去对家点一次名不是图标该有的本事。一枚紫色的小方块就够:
 * 要看的是「图标这条路通不通」,不是好不好看。
 */
const FAKE_BOT_ICON =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iNCIgZmlsbD0iI2E4NTVmNyIvPjxwYXRoIGQ9Ik01IDRoNGEyLjUgMi41IDAgMCAxIDAgNUg1eiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik01IDloNC41YTIuNSAyLjUgMCAwIDEgMCA1SDV6IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIuNzUiLz48L3N2Zz4=";

function text(value: string | number | undefined, fallback: string): string {
	return typeof value === "string" && value !== "" ? value : fallback;
}

/** `http://host:port/ext/<id>` → `ws://host:port/ext/<id>`。 */
function toWebSocketUrl(httpUrl: string): string {
	return httpUrl.replace(/^http/, "ws");
}

/**
 * 这一份开发入口的两条场景,加一个收摊的口(拓展停下时由入口挂在 `ctx.signal` 上)。
 * 每调一次起一份新的闭包 —— 模块顶层不存状态。
 */
export function bridgeScenarios(ctx: ExtensionDevtoolsContext): {
	scenarios: DevScenarioDef[];
	teardown(): void;
} {
	// 接入名单现读。`settings()` 这个口调多次没关系:形状对表,不比实例。
	const settings = ctx.settings(BridgeSettingsSchema);
	/** 眼下假装着的那一条。两条场景共用 —— 驮消息得先有条连着的桥。 */
	let live: { bridge: FakeBridge; connectionName: string; bots: BridgeBotWire[] } | undefined;
	/** 回执现读:面板上把它拨到「失败」,下一条推送就带着那句理由回去。 */
	let receipt: Result = ok();

	function teardown(): void {
		live?.bridge.dispose();
		live = undefined;
	}

	/** 哪条接入。空 = 第一条;给了按 id 或名字认。 */
	function pick(wanted: string | number | undefined): Result<{ link: BridgeLink }> {
		const read = settings.get();
		if (!read.ok && read.code !== "not_configured") {
			return fail("invalid", `桥的设置读不了:${read.message}`);
		}
		const all = read.ok ? read.settings.links : [];
		if (wanted === undefined || wanted === "") {
			const found = all[0];
			if (!found) {
				return fail("invalid", "还没有桥接入 —— 先去拓展页 · 机器人框架桥接建一条(它会生成 token)");
			}
			return ok({ link: found });
		}
		const key = String(wanted);
		const found = all.find((link) => link.id === key || link.name === key);
		if (!found) return fail("invalid", `没有这条接入:${key}`);
		return ok({ link: found });
	}

	/**
	 * 空 token 是合法可存的(脱敏备份把它抹成空串),但**永远连不上**,所以在这儿就说清楚。
	 */
	function tokenOf(link: BridgeLink): Result<{ token: string }> {
		if (link.token === "") {
			return fail(
				"invalid",
				`${link.name} 的 token 是空的 —— 去拓展页给它重新生成一把(脱敏备份恢复回来的就是空的)`,
			);
		}
		return ok({ token: link.token });
	}

	const connect: DevScenarioDef = {
		id: "connect",
		group: "state",
		title: "假装一条桥连上来",
		icon: "link",
		desc: "拿那条桥接入自己的 token 连一条真 WS 回桥自己的端点:拓展页那张卡当场变绿,bot 名单与能力矩阵有东西看。推送真的走到 adapter —— 回执是成是败这儿说了算,「失败提示」平时几乎没法看。收摊即断开。",
		params: [
			{ key: "link", label: "桥接入(名字或 id,空 = 第一条)", kind: "text", default: "" },
			{ key: "platform", label: "报一个什么平台的 bot", kind: "text", default: "onebot" },
			{ key: "caps", label: "能力表", kind: "enum", options: CAP_PRESETS, default: "mixed" },
			{
				key: "fail",
				label: "回执失败的理由(留空 = 都回成功)",
				kind: "text",
				default: "",
			},
		],
		async run(params) {
			const picked = pick(params.link);
			if (!picked.ok) return picked;
			const { link } = picked;
			const tokenResult = tokenOf(link);
			if (!tokenResult.ok) return tokenResult;
			const { token } = tokenResult;
			const mounted = ctx.mountUrl();
			// 端口是 `serve()` 之后才有的。没有就是还没起监听 —— 说清楚,别去连一个 undefined。
			if (!mounted) return fail("invalid", "HTTP 服务还没起来,等一下再按");

			const platform = text(params.platform, "onebot");
			// 握手那份名单是「还没探能力」的样子 —— 真插件也是这个次序:先报名单,探完
			// (小程序卡那格是唯一探得出来的)再推一份带答案的全量快照。
			const bots: BridgeBotWire[] = [
				{
					botId: "fake-bot-1",
					platform,
					name: "假 bot",
					selfId: FAKE_BOT_SELF_ID,
					icon: FAKE_BOT_ICON,
				},
			];
			const probed: BridgeBotWire[] = bots.map((bot) => ({
				...bot,
				capabilities: capabilitiesOf(String(params.caps ?? "mixed")),
			}));
			const failReason = text(params.fail, "");
			receipt = failReason === "" ? ok() : fail("unknown", failReason);

			// 再按一次 = 换一条新的(参数可能改了)。先把老的断掉,否则「同 token 新的赢」
			// 会由 BN 那头替我们断,而那一路上面板会闪一下「掉线又上线」。
			teardown();
			const bridge = createFakeBridge({
				http: ctx.http,
				url: toWebSocketUrl(mounted),
				token,
				kind: "koishi",
				name: "devtools 的假桥",
				version: "0.0.0-fake",
				bots,
				receipt: () => receipt,
			});
			try {
				await bridge.ready();
			} catch (err) {
				bridge.dispose();
				// 401 / 404 / 503 的分档在这句话里 —— 它是主人手里唯一的线索。
				return fail("invalid", `连不上:${(err as Error).message}`);
			}
			// 握完手才推带能力那份 —— 面板上于是看得见「矩阵从一片『还不知道』换成真答案」
			// 那一跳,而那一跳靠的是拓展喊 `statusChanged()`,不是主人切页重取。
			bridge.pushBots(probed);
			live = { bridge, connectionName: link.name, bots: probed };
			return ok({
				summary:
					`已假装一条桥连上 ${link.name},报了 1 个 ${platform} 的 bot(带平台图标);` +
					`能力表跟着握手后的第二份名单快照报上来,跟真插件探完能力一个次序。` +
					(failReason === "" ? "推过来的都回成功。" : `推过来的都回失败:${failReason}。`),
			});
		},
		active() {
			if (!live?.bridge.connected()) return null;
			return {
				scenarioId: "connect",
				label: `假桥 → ${live.connectionName}(${live.bots.length} 个 bot)`,
			};
		},
		reset: teardown,
	};

	const inbound: DevScenarioDef = {
		id: "inbound",
		group: "event",
		title: "桥驮一条消息上来",
		icon: "feather",
		desc: "让上面那条假桥回传一条消息,走的是真入站链路:私聊喂指令分发器,群消息喂链接解析。得先按「假装一条桥连上来」。发信人默认是编出来的号,BN 的指令分发器只认主人 —— 要以主人身份试指令,就把发信人改成主人的号;群消息里发信人不能填 bot 自己的号(链接解析不解析「机器人自己贴的」)。",
		params: [
			{ key: "scope", label: "哪一种", kind: "enum", options: SCOPES, default: "private" },
			{ key: "from", label: "发信人", kind: "text", default: DEFAULT_SENDER },
			{ key: "group", label: "群号(群消息才用)", kind: "text", default: DEFAULT_GROUP_ID },
			{
				key: "text",
				label: "正文",
				kind: "text",
				default: "",
				placeholder: "留空:私聊 /help,群消息带一条视频链接",
			},
		],
		run(params) {
			if (!live?.bridge.connected()) {
				return fail("invalid", "假桥还没连上 —— 先按「假装一条桥连上来」");
			}
			const userId = text(params.from, DEFAULT_SENDER);
			if (String(params.scope ?? "private") === "group") {
				const groupId = text(params.group, DEFAULT_GROUP_ID);
				const body = text(params.text, DEFAULT_GROUP_TEXT);
				live.bridge.sendInbound({ scope: "group", groupId, userId, text: body });
				// 发信人写进摘要:群里那条是谁说的决定了链接解析认不认它(自己贴的不解析),
				// 不说的话「驮上去了却什么都没发生」查不出是这个原因。
				return ok({
					summary: `已让假桥驮上来一条群 ${groupId} 的消息(发信人 ${userId}):「${body}」,回卡回到那个群。`,
				});
			}
			const body = text(params.text, "/help");
			live.bridge.sendInbound({ scope: "private", userId, text: body });
			return ok({ summary: `已让假桥驮上来一条 ${userId} 的私聊:「${body}」,回复走真链路。` });
		},
	};

	return { scenarios: [connect, inbound], teardown };
}
