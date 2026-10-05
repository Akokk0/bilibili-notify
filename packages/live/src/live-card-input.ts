/**
 * **B 站房间数据 → 中立的直播卡输入**(ADR-0019 决策 65 / 68;ADR-0021 决策 24 下 2026-10-05 的 🔗,㉒c)。
 *
 * 只此一份:直播引擎的推送(`RoomContext.sendLiveNotifyCard`)与面板的真实拉取预览(`routes/cards.ts`)都调它,
 * 再把 {@link LiveCardInput} 交给出卡入口 `ImageRenderer.generateLiveCard` —— 两边各翻一份的话,迟早出现
 * 「预览是这样、推出去是那样」。拓展订阅那头的对应翻译是服务端的 `liveCardInputFromReport`。
 *
 * 同住这里的 {@link biliLiveTimeToIso}:B 站 `live_time` 的唯一一份解析(此前出图器那头还有一份,合并了)。
 */

import { htmlToPlain, type LiveCardInput, type LiveCardStatus } from "@bilibili-notify/image";
import { DateTime } from "luxon";
import type { LiveData } from "./types";

/**
 * B 站 `live_time`(「yyyy-MM-dd HH:mm:ss」,**恒为北京时间**、不带时区)→ ISO 字符串。
 *
 * 显式按 `+08:00` 读,与进程时区无关(容器常常是 UTC,按本地时区读会平白差出 8 小时)。
 * 缺失、空串或解析不出(B 站对没开播的房间给 `0000-00-00 00:00:00`)回 `undefined`。
 */
export function biliLiveTimeToIso(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const at = DateTime.fromFormat(raw, "yyyy-MM-dd HH:mm:ss", { zone: "UTC+8" });
	return at.isValid ? (at.toUTC().toISO() ?? undefined) : undefined;
}

/**
 * 房间接口的 `data`。翻译读的是 `title` / `area_name` / `user_cover` / `keyframe` / `description` / `live_time` /
 * `online` 这几格,一律当 `unknown` 读 —— 接口的真实返回比 `LiveRoomInfo["data"]` 声明的多(`description`、
 * `online` 类型里没有),预览路由拿到的也只是一个带索引签名的对象。
 */
export type LiveRoomInfoFields = Readonly<Record<string, unknown>>;

/**
 * B 站给卡片的状态码 → 明写的状态。直播引擎传 `LiveType`,面板的真实拉取预览传 2,两套在 0 ~ 3 上恰好对得上。
 */
const BILI_LIVE_STATUS: Record<number, LiveCardStatus> = {
	0: "offline",
	1: "start",
	2: "streaming",
	3: "end",
};

const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** 接口里的人数:数字或数字样的字符串;缺了、不是有限的数都是 `undefined`(卡上那一格不画)。 */
function countOf(v: unknown): number | undefined {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

/** 值是 `undefined` 的键去掉:缺了就缺键(`toStrictEqual` 与序列化都看得出)。 */
function present<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, cell]) => cell !== undefined)) as T;
}

/**
 * **B 站那头 → 中立的直播卡输入**。卡上画什么全在这一步定好:
 *
 * - 封面:直播中先用关键帧(实时画面),开播 / 下播 / 没在播先用房间封面;**先取的那张没有,
 *   拿另一张兜** —— 没开播时 B 站给的关键帧是空串,刚开播时关键帧也常常还没生成。两张都
 *   没有就不给,出卡那头画占位图。给的是 `{ url }`(B 站的图到 3a 才存进图库)。
 * - 其余状态码(比如 4 首次开播,今天没有调用方传进出卡)照旧画成「直播中」角标、不写那句
 *   时间、先用房间封面 —— 与从前的默认分支一个样。
 * - 简介是富文本(可能带 `<p>` / `<br>` 或 entity-encoded 形式),先剥成纯文本。
 * - **不给主播头像**:`Creator.avatar` 只收图库引用,B 站的头像是远端地址,3a 才存进图库(ADR-0021 决策 24 下
 *   2026-10-05 的 🔗)。
 * - 人数**只收精确数,缺了就缺键**:此刻在线读房间接口的 `online`(缺了不补 0);点赞、粉丝数、粉丝数变化是直播
 *   引擎攒的(没收到点赞帧就没有点赞这一格)。累计观看今天引擎存的还是 B 站排好的字符串(`text_small`),
 *   这里不收 —— 等 ㉒d 改存精确数,读法已经就位(是数字才给)。
 *
 * @param data B 站直播间接口的 `data`(`getLiveRoomInfo`)。
 * @param liveData 直播引擎攒下的那几个数。
 * @param liveStatus 见 {@link BILI_LIVE_STATUS}。
 */
export function liveCardInputFromRoomInfo(
	data: LiveRoomInfoFields | null | undefined,
	username: string,
	liveData: LiveData,
	liveStatus: number,
): LiveCardInput {
	const known = BILI_LIVE_STATUS[liveStatus];
	const status = known ?? "start";
	const keyframe = text(data?.keyframe);
	const roomCover = text(data?.user_cover);
	const coverUrl =
		(status === "streaming" ? keyframe || roomCover : roomCover || keyframe) || undefined;
	return present({
		status,
		creator: { name: username },
		title: text(data?.title),
		category: text(data?.area_name),
		description: htmlToPlain(text(data?.description)),
		cover: coverUrl === undefined ? undefined : { url: coverUrl },
		startedAt: known ? biliLiveTimeToIso(text(data?.live_time)) : undefined,
		currentViewers: countOf(data?.online),
		likes: liveData.likedNum,
		totalViewers: typeof liveData.watchedNum === "number" ? liveData.watchedNum : undefined,
		followers: liveData.fansNum,
		followersDelta: liveData.fansChanged,
	});
}
