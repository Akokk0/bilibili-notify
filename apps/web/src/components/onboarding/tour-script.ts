import type { OnboardingStepKey } from "./derive";

/**
 * 「带我做」导览脚本(2026-08-29 二轮定案:控件级粒度 + 判据驱动)。
 *
 * 主步切换由机器判据驱动(reconcileTourPos 跟随 activeKey),主步内的子步
 * 才是手动翻页 —— 所以「扫码成功自动进下一步」不需要任何额外探测代码。
 *
 * `anchor` 指向页面控件上的 `data-tour` 挂点(高亮描边 + 滚入视口);
 * 控件级原则:聚光灯只指到按钮/区块,字段明细写在 `body` 文字里 ——
 * 表单改版时只需要核对文案,不用同步一堆字段锚点。
 */

export type TourAnchor = "bili-login" | "subs-search" | "adapter-add" | "target-add";

/** 锚点词表 —— 页面挂点与脚本引用的交集,测试钉住两边不脱节。 */
export const TOUR_ANCHORS: readonly TourAnchor[] = [
	"bili-login",
	"subs-search",
	"adapter-add",
	"target-add",
];

export interface TourSubStep {
	/** 该子步发生在哪个路由;伴随窗在别的页面时给「带我去」按钮。 */
	route: string;
	/** 高亮的控件挂点;纯说明步(选型/字段清单)不指控件。 */
	anchor?: TourAnchor;
	title: string;
	body: string;
}

export const TOUR_SCRIPT: Record<OnboardingStepKey, readonly TourSubStep[]> = {
	login: [
		{
			route: "/system",
			anchor: "bili-login",
			title: "扫码登录 B 站",
			body: "点高亮的「发起扫码登录」,用手机 B 站 App 扫码并确认。登录成功后这里会自动进入下一步。",
		},
	],
	subs: [
		{
			route: "/subs",
			anchor: "subs-search",
			title: "订阅第一个 UP",
			body: "在高亮的搜索框输入 UP 主名字或 UID,在结果里点「订阅」。订阅成功后自动进入下一步。",
		},
	],
	adapter: [
		{
			route: "/targets",
			title: "先选一条 QQ 接入路线",
			body: "只想推给自己 → 选「QQ 官方机器人」,表单里可扫码一键创建,零部署;要推到群里 / 想要图片卡片 → 选「OneBot」,需要先部署 NapCat(教程见新手指引·推送通道章)。想清楚了点「下一步」。",
		},
		{
			route: "/targets",
			anchor: "adapter-add",
			title: "新建推送适配器",
			body: "点高亮的「+ 新建」,选好平台:QQ 官方填 appId / appSecret(或点表单里的「扫码一键创建」自动回填);OneBot 选连接方式(推荐反向 WS,填一个监听端口)。填完点「保存」。",
		},
		{
			route: "/targets",
			title: "测试适配器连通",
			body: "在刚建好的适配器行上点「测试」—— 通过后状态点变绿,并自动进入下一步。失败的话按错误提示排查(OneBot 先确认 NapCat 已连上)。",
		},
	],
	target: [
		{
			route: "/targets",
			anchor: "target-add",
			title: "添加推送目标",
			body: "点高亮的「+ 新建」,选刚才的适配器,指定发到哪:OneBot 直接填群号或 QQ 号;QQ 官方要先在 QQ 里给机器人发一句话,然后在表单里选出现的会话。保存后自动进入下一步。",
		},
	],
	graduate: [
		{
			route: "/targets",
			title: "发送测试推送,毕业!",
			body: "在目标行点「测试」—— QQ 里收到测试消息就大功告成,之后订阅 UP 的动态与开播会自动推送到这里。",
		},
	],
};

export interface TourPos {
	stepKey: OnboardingStepKey | "done";
	subIndex: number;
}

/**
 * 判据跟随:activeKey(第一个未完成主步)变了就跳到新主步的第一个子步 ——
 * 前进与回退都跟随;没变则保持手动子步位置(越界收回,防脚本改短)。
 * 全绿(activeKey=null)进入 done 祝贺态。
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
