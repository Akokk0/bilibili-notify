import type {
	FeatureFlagValues,
	FeatureKey,
	PushTarget,
	Subscription,
	SubscriptionRouting,
} from "../../types/domain";
import { DEFAULT_FEATURE_FLAGS, FEATURE_KEYS } from "../../types/domain";

/**
 * 两样从 internal 转口的值,都是「页面和服务端必须是同一份」的东西:
 *
 * - **UP 主配色**:服务端渲染周报图片时要用同一套色,同一位 UP 在页面上和推到群里的
 *   图片上必须是同一个颜色。调色板的取舍见那边的说明。
 * - **要不要单发 @全体**(`shouldSendAtAll`):推送层据它(喂的是目标所挂连接的 `atAll` 能力)
 *   不给这种目标单发 @全体,这里据它禁用开关并提示「发送时会自动跳过」。曾经这里自己写了一份、
 *   推送层不知道,官机目标每次开播都多记一条「empty payload」失败 —— 界面上说跳过就得真的跳过。
 *
 * **必须走零依赖领域子路径**,不能从根入口拿:根入口带 zod,而这是页面里唯一
 * 一处从 internal 做**运行时**导入的地方 —— 曾经写成根入口,于是整个 zod(300+ 处
 * 引用)被拖进浏览器 bundle,只为一个调色板。其余对 internal 的引用一律 `import type`
 * (编译后擦除),见 `types/domain.ts` 开头那段。
 */
export { CREATOR_COLORS, colorFromSeed } from "@bilibili-notify/internal/identity";
export { shouldSendAtAll } from "@bilibili-notify/internal/push-target";
// displayName 真身在 utils/creator-display(组件层也要用,不能反向 import 页面层),这里转口。
export { displayName, profileAvatarUrl, subscriptionColor } from "../../utils/creator-display";

/**
 * 该订阅「实际开启」的推送特性 = `overrides.features` 覆写值,缺省继承**全局**特性开关
 * (`base`,调用方给 `globals.defaults.features`;没给 = 出厂值 DEFAULT_FEATURE_FLAGS)。
 * 等同 SubscriptionDialog「订阅项 · 默认推送内容」里的主开关。
 * routing(per-target 路由)是正交的另一根轴,不参与此判断 —— follow 模式加
 * 推送目标会灌满全部 routing,据 routing 判定会让卡片恒显全部特性。
 *
 * 基线为什么要是真正的全局值:面板没有全局特性开关的界面,全局值通常就是出厂值;唯独旧的
 * 「周期间隔大于 0」迁成了全局的 `features.liveStreaming = true`(直播拆键,⑬d),继承着它的订阅
 * 实际在推周期「正在直播」,卡片与弹层得显示成开、也得能关。
 */
export function subscribedFeatures(
	sub: Subscription,
	base: FeatureFlagValues = DEFAULT_FEATURE_FLAGS,
): FeatureKey[] {
	return FEATURE_KEYS.filter((k) => sub.overrides.features?.[k] ?? base[k]);
}

export function targetsById(targets: PushTarget[]): Map<string, PushTarget> {
	const m = new Map<string, PushTarget>();
	for (const t of targets) m.set(t.id, t);
	return m;
}

/**
 * 切到「自定义」推送模式时,target 的 routing 初始化为 = 订阅项生效特性集:
 * subscribedFeatures 命中的 feature 收该 target,未命中的把它剔除;其余 target
 * 原样保留。让「自定义」从「跟随订阅项现状」起步,而非默认全部特性全开。
 */
export function routingAlignedToFeatures(
	sub: Subscription,
	targetId: string,
	base: FeatureFlagValues = DEFAULT_FEATURE_FLAGS,
): SubscriptionRouting {
	const want = new Set<FeatureKey>(subscribedFeatures(sub, base));
	const out = {} as SubscriptionRouting;
	for (const k of FEATURE_KEYS) {
		const cur = sub.routing[k];
		const has = cur.includes(targetId);
		if (want.has(k)) {
			out[k] = has ? cur : [...cur, targetId];
		} else {
			out[k] = has ? cur.filter((id) => id !== targetId) : cur;
		}
	}
	return out;
}
