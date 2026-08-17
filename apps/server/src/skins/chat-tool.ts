/**
 * 聊天里的 `create_skin` —— 女仆手上唯一一个**会写东西**的工具。
 *
 * 它只挂在 dashboard 的聊天上(见 `packages/ai` 的 ExtraTool 文档):那条路坐在
 * cookie session 后面,说话的只有主人本人。koishi 群聊那两条路拿不到它。
 *
 * 工具本身不认识皮肤规格 —— 它把一句话交给 `runSkinAiCreate` 嵌套跑一次专职的
 * 皮肤设计师调用,拿回清洗过的 manifest 再落盘。所以聊天的 system 里一个字的
 * 皮肤 schema 都不必带。
 */

import type { ExtraTool } from "@bilibili-notify/ai";
import { runSkinAiCreate } from "./ai-create.js";
import type { SkinAiGenerator } from "./ai-edit.js";
import type { SkinStore } from "./store.js";

/**
 * 一轮对话最多真做几套。每次聊天请求现配一把工具,预算就跟着那一把走。
 *
 * 为什么要有上限:一次生成是一整趟模型调用(几十秒 + 真金白银),而「再改改」在
 * 模型眼里跟「再做一套」只有一线之隔 —— 没有闸的话,主人一句「不太对」可能换来
 * 皮肤库里躺着七套半成品。
 */
const MAX_CREATES_PER_TURN = 2;

const MODE_LABEL = { light: "浅色", dark: "暗色" } as const;

export function createSkinChatTool(deps: {
	skinStore: SkinStore;
	/** 热读:engines 是后挂的,每次调用现取。null = AI 未配置 / 未就绪。 */
	generator: () => SkinAiGenerator | null;
}): ExtraTool {
	let made = 0;

	return {
		definition: {
			type: "function",
			function: {
				name: "create_skin",
				description:
					"为面板设计并生成一整套界面皮肤(配色 / 玻璃质感 / 阴影 / 动效 / 自定义 CSS),存进皮肤库。只在主人明确想要新皮肤、换界面风格时调用;生成要等几十秒,一轮对话最多做两套。brief 用一段话把主人要的风格说清楚(氛围、主色、明暗、想要的质感),主人只给了一个词时由你补全细节。",
				parameters: {
					type: "object",
					properties: {
						brief: {
							type: "string",
							description: "想要的皮肤风格描述,越具体越好(氛围、主色调、浅色还是暗色、质感)",
						},
						activate: {
							type: "boolean",
							description:
								"做完是否立刻替主人换上。只有主人明确说了「换上 / 直接用」之类才传 true,默认不换。",
						},
					},
					required: ["brief"],
				},
			},
		},

		async execute(args) {
			const brief = (args.brief ?? "").trim();
			if (!brief) throw new Error("没说要什么样的皮肤,先问清主人想要的风格再来。");
			if (made >= MAX_CREATES_PER_TURN) {
				throw new Error(
					`这一轮已经做了 ${MAX_CREATES_PER_TURN} 套,够多了 —— 先请主人看看效果,想再做等下一句话。`,
				);
			}
			const generator = deps.generator();
			if (!generator) {
				throw new Error("智能女仆还没接好模型,先去 AI 设置页把 baseUrl / apiKey 填齐。");
			}

			made++;
			const result = await runSkinAiCreate({
				generateRaw: (s, u) => generator.generateRaw(s, u),
				brief,
			});
			if (!result.ok) {
				// 原因原样带回给模型 —— 它才能跟主人说清是哪儿没做成,而不是干瞪眼。
				throw new Error(`皮肤生成失败:${result.errors.join(";")}`);
			}

			const { manifest } = result;
			const { id } = await deps.skinStore.save({ manifest, assets: new Map() });
			const modes = (["light", "dark"] as const).filter((m) => manifest.modes[m]);
			const modeText = modes.map((m) => MODE_LABEL[m]).join(" + ");

			// 入参过执行层时被逐值 String 归一(见 ExtraTool 文档),布尔到手是字符串。
			if (args.activate === "true") {
				await deps.skinStore.activate(id);
				return `已生成皮肤「${manifest.name}」(${modeText})并替主人换上了,${modeText}模式下即时生效。`;
			}
			// 别在这儿写「叫我换上」之类:女仆手上并没有换装工具,她能做的只有再做
			// 一套(activate=true)。承诺一个不存在的能力,主人一说「那你换上」就卡住。
			return `已生成皮肤「${manifest.name}」(${modeText})并存进皮肤库,还没换上 —— 主人到「皮肤」页就能试穿。`;
		},
	};
}
