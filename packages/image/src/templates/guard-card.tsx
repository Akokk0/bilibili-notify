/**
 * 这种卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图七个入口
 * 早就全走皮肤渲染器,模板只剩测试还在渲染(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份 props,所以类型留在原地。
 *
 * `layout` 还留着:上舰卡的 `name` **复合块**按它决定徽章在哪边,那块下一片才删。
 */
import type { GuardLevel } from "@bilibili-notify/blive";
import type { GuardLayout } from "@bilibili-notify/internal";

export type GuardCardProps = {
	captainImgUrl: string;
	guardLevel: GuardLevel;
	uname: string;
	face: string;
	isAdmin: number;
	masterAvatarUrl: string;
	masterName: string;
	bgColor: [string, string];
	/**
	 * guard 受限 2D 版式。`badgeSide` 决定徽章块靠左/靠右,`blocks`(name/text/可插分割线)
	 * 在另一侧上下排、顺序+显隐+边距由数组决定。缺省 = `DEFAULT_CARD_LAYOUT.guard`。
	 */
	layout?: GuardLayout;
	/** 玻璃片(内容层)透明度 0..1;缺省走 guard 基线 0.75。 */
	glassOpacity?: number;
	/** 完全透明:白层透明 + 去掉毛玻璃模糊,底图完全清晰透出(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};
