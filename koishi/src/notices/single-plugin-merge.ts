import type {} from "@koishijs/plugin-notifier";
import type { Context } from "koishi";

/**
 * v5 单插件合并告知。
 *
 * 原先的**六个**插件(core / dynamic / live / ai / image / advanced-subscription)
 * 合并成了这一个。这是**需要用户动手**的破坏性变更,不是无感升级:
 *
 * - 五个旧子插件必须卸载(`-dynamic` / `-live` / `-ai` / `-image` /
 *   `-advanced-subscription`,五个都还在 npm 上,用户手里很可能装着)。它们靠
 *   `probeInternals()` / `BILIBILI_NOTIFY_TOKEN` 探针协议跨包访问核心的
 *   api/push/store,而 v5 把这套协议整个删了(单包内部直接持有引用)—— 所以旧子插件
 *   **留着也无法工作**。不明说这一点,用户会以为不卸载无所谓,然后对着一个根本跑不
 *   起来的旧插件排查半天。
 * - 配置结构按功能域重组成八段(account / push / subscriptions / render / ai /
 *   dynamic / live / advancedSub)。原先散在各插件自己 config 里的同名字段
 *   (logLevel、cardColorStart 之类)都换了位置,升级后要对照控制台重填一遍。
 *
 * 迁移期过后删掉本模块即可(notifier 随插件生命周期常驻,不会自己消失)。
 *
 * 注:`h` 由调用方注入而非在此 `import { h } from "koishi"` —— 运行时引入 koishi
 * 主入口会拉起 `@koishijs/loader`,在单测环境里直接爆掉(Class extends value is not
 * a constructor)。本模块因此只持有纯数据,不碰 koishi 运行时。
 */

/**
 * 渲染一段文本节点的最小 `h` 形状(koishi 的 `h` 满足它)。children 用 `any` 是
 * 必要的:koishi 的 `h` 声明为 `(tag, ...children: Fragment[])`,严格函数类型下参数
 * 逆变 —— 写成 `unknown[]` 会让真正的 `h` 无法赋值进来。
 */
// biome-ignore lint/suspicious/noExplicitAny: 见上,参数逆变
type HFactory = (tag: string, ...children: any[]) => unknown;

/** 文案逐行。抽出来是为了能被测试钉住 —— 它是给所有用户看的对外文字。 */
export const SINGLE_PLUGIN_LINES = [
	"⚠️ v5 重大更新：六个插件已合并为一个",
	"动态推送、直播推送、卡片渲染现在都是本插件的核心能力，启用即开；AI 点评与高级订阅改为配置里的开关（ai.enabled / advancedSub.enabled）。",
	"请卸载这五个旧子插件：bilibili-notify-dynamic / -live / -ai / -image / -advanced-subscription。它们依赖的内部接口已在 v5 移除，留着也无法工作。",
	"配置结构已按功能域重组为 account / push / subscriptions / render / ai / dynamic / live / advancedSub 八段，升级后请对照控制台重新填写一遍。",
] as const;

/** 构造 notifier 载荷。warning 档:要用户动手,但它不是一条报错。 */
export function buildSinglePluginNotice(h: HFactory) {
	const [title, ...body] = SINGLE_PLUGIN_LINES;
	return {
		type: "warning" as const,
		content: [h("p", h("b", title)), ...body.map((line) => h("p", line))],
	};
}

/** 把告知挂到 koishi 控制台。 */
export function installSinglePluginNotice(ctx: Context, h: HFactory): void {
	// biome-ignore lint/suspicious/noExplicitAny: h 注入后类型退化,notifier 只认 h.Fragment
	ctx.notifier.create(buildSinglePluginNotice(h) as any);
}
