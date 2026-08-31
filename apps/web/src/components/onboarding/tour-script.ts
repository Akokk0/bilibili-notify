import type { OnboardingStepKey, OnboardingView } from "./derive";

/**
 * 「带我做」导览脚本(2026-08-29 二轮定案:控件级粒度 + 判据驱动)。
 *
 * 主步切换由机器判据驱动(reconcileTourPos 跟随 activeKey),主步内的子步
 * 才是手动翻页 —— 所以「扫码成功自动进下一步」不需要任何额外探测代码。
 * 主步顺序:登录 → 适配器 → 目标 → 测试 → 订阅(理由见 derive.ts)。
 *
 * `anchor` 指向页面控件上的 `data-tour` 挂点(高亮描边 + 滚入视口);
 * 控件级原则:聚光灯只指到按钮/区块,字段明细写在 `body` 文字里 ——
 * 表单改版时只需要核对文案,不用同步一堆字段锚点。
 */

/** 锚点词表 —— 页面挂点与脚本引用的交集,测试钉住两边不脱节。
 *  类型由它派生(站里通行写法,见 config/nav 的 NAV_ITEMS、contract 的 CHANNELS):
 *  词表与联合类型分两处手写的话,漏一处不会红,只会让守卫少覆盖一个锚点。 */
export const TOUR_ANCHORS = [
	"bili-login",
	"bili-login-qr",
	"subs-search",
	"subs-add",
	"adapter-add",
	"adapter-form",
	"adapter-test",
	"adapter-config",
	"target-add",
	"target-form",
	"target-test",
	"target-config",
	"target-list",
] as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[number];

/**
 * 只住在 `ModalShell` 里的挂点 —— 弹窗没开时它们不存在,开了聚光灯又整体让位。
 * 一条锚点链**全是**它们,灯就永远不亮(subs 步栽过),测试拿这份钉住。
 *
 * 放在词表旁边而不是测试里:加锚点的人在这儿,不在测试文件里 —— 漏标一个
 * 不会红,只会让那条不变式悄悄放行一条永远不亮的链。
 */
export const MODAL_ONLY_ANCHORS: ReadonlySet<TourAnchor> = new Set<TourAnchor>([
	"bili-login-qr",
	"adapter-form",
	"target-form",
	"subs-search",
]);

export interface TourSubStep {
	/** 该子步发生在哪个路由;在别的页面时聚光灯照到顶栏对应页签上指路。 */
	route: string;
	/**
	 * 高亮的控件挂点;纯说明步(选型/字段清单)不指控件。
	 * 数组 = **优先级链**(靠前优先):聚光灯每帧取链上第一个存在于页面的锚点,
	 * 交互后就地弹出的内容(如登录二维码)挂更高优先级,聚光灯自动转移过去。
	 */
	anchor?: TourAnchor | readonly TourAnchor[];
	/**
	 * 测试失败悬着(view.failNote 非空)时改用的锚点链 —— 灯移到「配置」:
	 * 不改配置,重测永远失败(2026-08-30 主人拍板)。
	 *
	 * 数组元素 = **同亮组**:组内多个锚点拼成一个 selector 一起开洞。「配置」与
	 * 「测试」结成一组 —— 引导锁**不放开**(放开过一版,主人打回),但外部原因
	 * (NapCat 掉线之类)修好后不用进配置,重测那颗也得在洞内可点。
	 * 链头必须挂**弹窗内的表单锚点**:「过弹窗即复原」靠链解析进 modal 才触发,
	 * 不带的话点「配置」退散 → 弹窗开着链还停在页面按钮上 → 取消回来灯已失踪
	 * (真机踩过)。
	 */
	anchorOnFail?: readonly (TourAnchor | readonly TourAnchor[])[];
	/**
	 * 抵达 `route` 即视为此子步完成,自动流转到下一子步 —— 给「出发前想清楚」类
	 * 说明步用:用户跟着聚光灯点亮起的导航页签,一到目标页就进入动手子步,
	 * 不会出现「聚光灯已指到控件、小卡文案还在讲选型」的错位(真机踩过)。
	 * 这类子步不给「下一步」按钮(流转方式就是抵达),也不该配 anchor。
	 */
	advanceOnRoute?: boolean;
	/**
	 * 此子步的目标已达成的判据 —— 成立即自动流转到下一子步(与 advanceOnRoute
	 * 同为单向自动流转,只是信号来自探测数据而非路由)。给「主步内的中间动作」用:
	 * 主步判据只认最终结果(如适配器**测通**),而「建好适配器」这一步做完时导览
	 * 必须立刻把灯移到「测试」上,不能等用户自己想起来。
	 */
	doneWhen?: (view: OnboardingView) => boolean;
	title: string;
	body: string;
	/** 深入阅读的站内跳转按钮 —— 复杂讲解(选型表/部署教程)不塞小卡,指去教程页。 */
	link?: { to: string; label: string };
}

export const TOUR_SCRIPT: Record<OnboardingStepKey, readonly TourSubStep[]> = {
	login: [
		{
			route: "/system",
			// 二维码弹窗一出现,链解析到 qr(在 modal 内)→ 聚光灯让位给弹窗;关掉回落按钮
			anchor: ["bili-login-qr", "bili-login"],
			title: "扫码登录 B 站",
			body: "点高亮的「发起扫码登录」,用手机 B 站 App 扫码并确认。登录成功后这里会自动进入下一步。",
		},
	],
	adapter: [
		{
			route: "/targets",
			// 出发前的选型思考步:不配 anchor(在目标页的动手指引归下一子步),
			// 抵达 /targets 即流转 —— 灯与文案永远同步
			advanceOnRoute: true,
			title: "先选一条接入路线",
			body: "BN 有三类适配器:「QQ 官方机器人」「OneBot(NapCat 等协议端)」「Webhook(钉钉 / 飞书等)」,能力与部署成本各不同 —— 具体区别看「选型指引」,想清楚了再动身。",
			link: { to: "/about/guide", label: "选型指引" },
		},
		{
			route: "/targets",
			// 表单弹窗打开时链解析到 form(在 modal 内)→ 聚光灯让位;adapter-add 挂在
			// 左栏「+ 新建」与空态主 CTA 两处 —— 同名实例是等价入口,灯一起亮
			anchor: ["adapter-form", "adapter-add"],
			// 保存落库的那一刻翻页 —— 灯立刻移到「测试」按钮,不等用户自己想起来
			doneWhen: (v) => v.hasAdapter,
			title: "新建推送适配器",
			body: "点高亮的「+ 新建」,选好平台:QQ 官方填 appId / appSecret(或点表单里的「扫码连接 / 创建」自动回填);OneBot 选连接方式(推荐反向 WS,填一个监听端口)。填完点「保存」。",
			// 上一子步在抵达时自动翻过 —— 一直待在本页的用户全程见不到它,选型入口在这也挂一份
			link: { to: "/about/guide", label: "选型指引" },
		},
		{
			route: "/targets",
			// 控件级:灯指适配器详情区的「测试」按钮本体;挂点没渲染时回落适配器区
			anchor: ["adapter-test", "adapter-add"],
			anchorOnFail: ["adapter-form", ["adapter-config", "adapter-test"], "adapter-add"],
			title: "测试适配器连通",
			body: "在刚建好的适配器行上点「测试」—— 通过后状态点变绿,并自动进入下一步。失败的话按错误提示排查(OneBot 先确认 NapCat 已连上)。",
		},
	],
	target: [
		{
			route: "/targets",
			// 同 adapter:弹窗内让位;target-add 挂右上按钮与空态 AddCard 两处,一起亮。
			// 末尾必须留 target-list 兜底:**选中的适配器是 webhook 时 target-add 一处
			// 都不渲染**(右上按钮被 platform 判断掐掉,空态 AddCard 走的是另一条分支),
			// 链解析不到任何元素 → 灯不亮、锁不铺,而小卡还在说「点高亮的『+ 新建』」,
			// 指着一个不存在的东西;又因为人已经在目标路由上,「点亮起的页签前往」那条
			// 降级提示也被抑制,导览就此死在这儿(2026-08-31 审查)。test 步早有这条兜底。
			anchor: ["target-form", "target-add", "target-list"],
			title: "添加推送目标",
			body: "点高亮的「+ 新建」,选刚才的适配器,指定发到哪:OneBot 直接填群号或 QQ 号;QQ 官方要先在 QQ 里给机器人发一句话,然后在表单里选出现的会话。保存后自动进入下一步。",
		},
	],
	test: [
		{
			route: "/targets",
			// 控件级:灯指第一个未测通目标行的「测试」按钮;挂点没渲染时回落目标区
			anchor: ["target-test", "target-list"],
			anchorOnFail: ["target-form", ["target-config", "target-test"], "target-list"],
			title: "发送测试推送",
			body: "在目标行点「测试」—— QQ 里收到测试消息,推送通道就全线打通了。只差最后一步:订阅要关注的 UP。",
		},
	],
	subs: [
		{
			route: "/subs",
			// 搜索框住在「添加 UP 主」弹窗里(弹窗没开时挂点不存在,开了又整体让位),
			// 页面级灯位是右上恒在的「添加」按钮 —— 弹窗一开链解析进 modal,灯自动让位
			anchor: ["subs-search", "subs-add"],
			title: "订阅第一个 UP",
			body: "点高亮的「添加」,搜索 UP 主名字或 UID,在结果里点「订阅」,并勾上刚建好的推送目标。订阅成功即大功告成,TA 的动态与开播会自动推送到 QQ。",
		},
	],
};

/** 主步完成时在操作位置弹出的完成徽章文案 —— 判据变绿的那一拍就地反馈,
 *  不然小卡文案无声切到下一步,用户不知道刚才那步已经成了(真机反馈:突兀)。 */
export const STEP_DONE_MESSAGES: Record<OnboardingStepKey, string> = {
	login: "B 站登录完成!",
	adapter: "适配器连通了!",
	target: "推送目标建好了!",
	test: "测试消息已送达,通道全线打通!",
	subs: "订阅成功,大功告成!",
};

export interface TourPos {
	stepKey: OnboardingStepKey | "done";
	subIndex: number;
}

/**
 * 判据跟随:activeKey(第一个未完成主步)变了就跳到该主步的第一个子步 ——
 * **前进与回退都跟**。回退=前置被破坏(退出登录、删掉已测通的适配器),导览
 * 必须带用户回去补,否则卡在一个做不了的后续步上(真机踩过:退出登录后停在
 * 适配器步,登录被略过)。「顺序流转、不回头」只约束**交互层** —— 没有
 * 「上一步」按钮,用户不能手动倒退;判据说话永远算数。
 * 没变则保持手动子步位置(越界收回,防脚本改短);全绿(activeKey=null)进入
 * done 祝贺态。
 */
export function reconcileTourPos(
	pos: TourPos | null,
	activeKey: OnboardingStepKey | null,
): TourPos {
	if (activeKey === null) return { stepKey: "done", subIndex: 0 };
	if (!pos || pos.stepKey !== activeKey) return { stepKey: activeKey, subIndex: 0 };
	const max = TOUR_SCRIPT[activeKey].length - 1;
	return { stepKey: activeKey, subIndex: Math.min(pos.subIndex, max) };
}
