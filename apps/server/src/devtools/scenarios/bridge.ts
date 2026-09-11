/**
 * 「假装一条桥连上来」—— 把「验桥」从「必须先写插件」解绑。
 *
 * 没有真插件时,拓展页上那条桥接入永远是灰的:能力矩阵、状态面板、bot 名单、失败提示
 * 一格都看不见。这两条场景拿那条接入自己的 token 连一条**真 socket** 回 BN 身上,于是
 * upgrade、鉴权、握手、`publishStatus`、推送 adapter、回执全是真的 —— 假的只有
 * 「后面没有 bot」这一件。连上之后推送目标页「新建连接」里就挑得到那个假 bot。
 *
 * 🔴 **这是「真动作」还是「假状态」?** —— 是**假状态**:连着的这条是 devtools 造出来的,
 * 面板上那条卡因它变绿。所以它进「当前生效」条、也归一键收摊(见 `devtools.md` 那条
 * 「假状态只由 devtools 收摊」)。反过来,它带来的推送**是真的发生过**的:历史里那行、
 * 失败提示那句都不清 —— 那是真动作。
 *
 * ⚠️ 帧在 `../fake-bridge.ts` 里手写(核心 import 不到拓展),那笔账记在 ADR-0012 决策 42。
 */

import type { ChatIdentity } from "@bilibili-notify/internal";
import { createFakeBridge, type FakeBridge, type FakeBridgeBot } from "../fake-bridge.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/** 桥那个拓展的 id。挂载点 `/ext/<id>` 与设置住在哪一格都按它认。 */
const BRIDGE_EXTENSION_ID = "bridge";

/** 一条桥接入 —— 只抠这几格,形状归桥自己(见 `links()`)。 */
interface BridgeLink {
	id: string;
	name: string;
	token: string;
	enabled: boolean;
}

export interface BridgeScenarioDeps {
	/**
	 * 桥那个拓展自己的设置(`globals.extensions.bridge.settings`),**原样**。接入名单
	 * (token 住在里面)在这儿,不在连接表里 —— 连接是「一个 bot」(ADR-0012 决策 45)。
	 */
	settings: () => unknown;
	/**
	 * BN 自己的 `host:port`。**现取** —— `serve()` 在 `createDevtools` 之后才拿到端口,
	 * 建表那一刻它还不存在。
	 */
	address: () => string | undefined;
	/** 私聊那条驮上去时默认拿主人的号 —— 不是主人的话指令分发器根本不理。 */
	commands: () => { prefix: string; master?: ChatIdentity };
}

const CAP_PRESETS = [
	{ value: "mixed", label: "三态齐全(看矩阵)" },
	{ value: "all", label: "全都支持" },
	{ value: "none", label: "全都不支持" },
] as const;

/**
 * 六项能力(见协议 §7)。`mixed` 那一档**刻意把三态凑齐**:「还不知道」在真环境里最难
 * 凑出来,而它恰恰是面板上最容易被误读成「不支持」的一格。
 */
function capabilitiesOf(preset: string): Record<string, string> {
	if (preset === "all") {
		return {
			atAll: "supported",
			inbound: "supported",
			forward: "supported",
			miniAppCard: "supported",
			shareCardLinks: "supported",
			markdown: "supported",
		};
	}
	if (preset === "none") {
		return {
			atAll: "unsupported",
			inbound: "unsupported",
			forward: "unsupported",
			miniAppCard: "unsupported",
			shareCardLinks: "unsupported",
			markdown: "unsupported",
		};
	}
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

function text(value: string | number | undefined, fallback: string): string {
	return typeof value === "string" && value !== "" ? value : fallback;
}

export function bridgeScenarios(deps: BridgeScenarioDeps): DevScenarioDef[] {
	/** 眼下假装着的那一条。两条场景共用 —— 驮消息得先有条连着的桥。 */
	let live: { bridge: FakeBridge; connectionName: string; bots: FakeBridgeBot[] } | undefined;
	/** 回执现读:面板上把它拨到「失败」,下一条推送就带着那句理由回去。 */
	let receipt: { ok: boolean; err?: string } = { ok: true };

	function teardown(): void {
		live?.bridge.dispose();
		live = undefined;
	}

	/**
	 * 接入名单从桥的设置里读。
	 *
	 * ⚠️ 核心**不认识**拓展设置的形状(那归拓展自己那份 zod,ADR-0012 决策 19),所以这里
	 * 是按键名读的 —— 与桥自己 `resolveBridgeToken` 读的是同一格。读得防着点:形状不对就当
	 * 一条都没有,别在 devtools 里炸。
	 */
	function links(): BridgeLink[] {
		const raw = (deps.settings() as { links?: unknown } | undefined)?.links;
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((entry): BridgeLink[] => {
			const link = entry as Partial<Record<keyof BridgeLink, unknown>> | undefined;
			if (typeof link?.id !== "string" || typeof link.name !== "string") return [];
			return [
				{
					id: link.id,
					name: link.name,
					token: typeof link.token === "string" ? link.token : "",
					enabled: link.enabled !== false,
				},
			];
		});
	}

	/** 哪条接入。空 = 第一条;给了按 id 或名字认。 */
	function pick(wanted: string | number | undefined): BridgeLink {
		const all = links();
		if (wanted === undefined || wanted === "") {
			const found = all[0];
			if (!found) {
				throw new DevParamError(
					"还没有桥接入 —— 先去拓展页 · 机器人框架桥接建一条(它会生成 token)",
				);
			}
			return found;
		}
		const key = String(wanted);
		const found = all.find((link) => link.id === key || link.name === key);
		if (!found) throw new DevParamError(`没有这条接入:${key}`);
		return found;
	}

	/**
	 * 空 token 是合法可存的(脱敏备份把它抹成空串),但**永远连不上**,所以在这儿就说清楚。
	 */
	function tokenOf(link: BridgeLink): string {
		if (link.token === "") {
			throw new DevParamError(
				`${link.name} 的 token 是空的 —— 去拓展页给它重新生成一把(脱敏备份恢复回来的就是空的)`,
			);
		}
		return link.token;
	}

	const connect: DevScenarioDef = {
		id: "bridge.connect",
		group: "state",
		title: "假装一条桥连上来",
		icon: "link",
		desc: "拿那条桥接入自己的 token 连一条真 WS 回 BN 身上:拓展页那张卡当场变绿,bot 名单与能力矩阵有东西看。推送真的走到 adapter —— 回执是成是败这儿说了算,「失败提示」平时几乎没法看。收摊即断开。",
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
			const link = pick(params.link);
			const token = tokenOf(link);
			const address = deps.address();
			// 端口是 `serve()` 之后才有的。没有就是还没起监听 —— 说清楚,别去连一个 undefined。
			if (!address) throw new DevParamError("HTTP 服务还没起来,等一下再按");

			const platform = text(params.platform, "onebot");
			const bots: FakeBridgeBot[] = [
				{
					botId: "fake-bot-1",
					platform,
					name: "假 bot",
					selfId: "900400001",
					capabilities: capabilitiesOf(String(params.caps ?? "mixed")),
				},
			];
			const fail = text(params.fail, "");
			receipt = fail === "" ? { ok: true } : { ok: false, err: fail };

			// 再按一次 = 换一条新的(参数可能改了)。先把老的断掉,否则「同 token 新的赢」
			// 会由 BN 那头替我们断,而那一路上面板会闪一下「掉线又上线」。
			teardown();
			const bridge = createFakeBridge({
				url: `ws://${address}/ext/${BRIDGE_EXTENSION_ID}`,
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
				throw new DevParamError(`连不上:${(err as Error).message}`);
			}
			live = { bridge, connectionName: link.name, bots };
			return {
				summary:
					`已假装一条桥连上 ${link.name},报了 1 个 ${platform} 的 bot。` +
					(fail === "" ? "推过来的都回成功。" : `推过来的都回失败:${fail}。`),
			};
		},
		active() {
			if (!live || !live.bridge.connected()) return null;
			return {
				scenarioId: "bridge.connect",
				label: `假桥 → ${live.connectionName}(${live.bots.length} 个 bot)`,
			};
		},
		reset: teardown,
	};

	const inbound: DevScenarioDef = {
		id: "bridge.inbound",
		group: "event",
		title: "桥驮一条消息上来",
		icon: "feather",
		desc: "让上面那条假桥回传一条消息,走的是真入站链路:私聊喂指令分发器(发信人省略 = 配置里的主人,所以会被当真),群消息喂链接解析。得先按「假装一条桥连上来」。",
		params: [
			{ key: "scope", label: "哪一种", kind: "enum", options: SCOPES, default: "private" },
			{ key: "from", label: "发信人 / 群号(可空)", kind: "text", default: "" },
			{ key: "text", label: "正文", kind: "text", default: "" },
		],
		run(params) {
			if (!live || !live.bridge.connected()) {
				throw new DevParamError("假桥还没连上 —— 先按「假装一条桥连上来」");
			}
			const master = deps.commands().master;
			const scope = String(params.scope ?? "private");
			const given = text(params.from, "");
			if (scope === "group") {
				if (given === "") throw new DevParamError("群消息得给一个群号");
				const body = text(params.text, DEFAULT_GROUP_TEXT);
				const userId = master?.address ?? "900400001";
				live.bridge.sendInbound({ scope: "group", groupId: given, userId, text: body });
				return { summary: `已让假桥驮上来一条群 ${given} 的消息:「${body}」,回卡回到那个群。` };
			}
			const userId = given !== "" ? given : master?.address;
			if (!userId) {
				throw new DevParamError("没配主人(系统页 · 主人私聊),得给一个发信人");
			}
			// 前缀现取 —— 系统页上随时能改,烤进声明表的话按它跑一次分发器根本不认。
			const body = text(params.text, `${deps.commands().prefix}help`);
			live.bridge.sendInbound({ scope: "private", userId, text: body });
			return { summary: `已让假桥驮上来一条 ${userId} 的私聊:「${body}」,回复走真链路。` };
		},
	};

	return [connect, inbound];
}
