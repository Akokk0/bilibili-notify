/**
 * 聊天界面上的称呼 —— 全部取自「智能女仆」页配的人格,不写死。
 *
 * 设计稿里通篇是「小铃」,那只是画稿时随手起的名字;真实的名字、自称、对主人的
 * 称呼都在 `globals.defaults.ai.persona` 里,主人换了预设(温柔女仆 / 傲娇 /
 * 冷静分析师…)或自己改过名字,聊天界面得跟着变 —— 否则会出现「侧栏写着小铃、
 * 她自己开口自称小绫」这种精神分裂。
 *
 * 三个字段各有各的用处,别混:
 * - {@link ChatPersona.name} 是**第三人称的标签**:侧栏标题、输入框 placeholder
 * - {@link ChatPersona.self} 是**她的自称**:凡是以她口吻写的句子(出错了、正在思考)
 * - {@link ChatPersona.user} 是**她怎么称呼主人**:同样只用在她口吻的句子里
 */

/** 人格里与称呼有关的那几栏。只声明用得到的,不绑整个 GlobalConfig。 */
export interface PersonaSource {
	name?: string;
	addressSelf?: string;
	addressUser?: string;
}

export interface ChatPersona {
	name: string;
	self: string;
	user: string;
}

/** 配置还没加载 / 字段被清空时的兜底。宁可显示一个通用称呼,也不要空白。 */
const FALLBACK_NAME = "女仆";
const FALLBACK_USER = "主人";

/**
 * 人格配置 → 界面上的三个称呼。
 *
 * `undefined`(globals 还在路上)与空串(主人把那栏清空了)一视同仁,都走兜底。
 * `self` 缺失时回落到 `name` 而不是兜底词 —— 名字都有了,自称却写「女仆」很怪。
 */
export function resolveChatPersona(persona?: PersonaSource): ChatPersona {
	const name = persona?.name?.trim() || FALLBACK_NAME;
	return {
		name,
		self: persona?.addressSelf?.trim() || name,
		user: persona?.addressUser?.trim() || FALLBACK_USER,
	};
}
