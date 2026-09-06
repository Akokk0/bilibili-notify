import { GuardLevel, type LiveUser } from "@bilibili-notify/blive";
import { DevParamError, type DevScenarioDef } from "../registry.js";
import { pickRoom, type RoomPickerDeps } from "./live.js";

/**
 * A2:弹幕批量 / SC / 上舰 / 礼物 / 进场 —— 往房间的事件漏斗塞 LiveEvent,形状与 blive 解析
 * 出来的完全一样,room-session 分不出真假。房间得在(假)直播中才有下文:弹幕只在开播态收集,
 * SC / 上舰经各自的门槛(minScPrice / minGuardLevel)后推卡。
 *
 * 弹幕批量的默认值是冲门槛去的:词云要 ≥ 50 个热词、总结要 ≥ 5 位发言人 —— 60 条 / 8 人,
 * 内容从一池各不相同的句子里轮着取,分词后热词够数。
 */

/** 假观众:uid 从 9 亿起,与真人不撞。 */
function fakeUser(i: number): LiveUser {
	return { uid: 900_000_000 + i, uname: `假观众${i + 1}号` };
}

/** 弹幕池:各不相同、词汇散开,分词后能凑出 50 个以上热词。 */
const DANMAKU_POOL = [
	"主播今天状态好棒",
	"这波操作太秀了",
	"晚上好晚上好",
	"来晚了来晚了刚下班",
	"这个游戏叫什么名字",
	"主播吃饭了吗",
	"背景音乐好听",
	"哈哈哈哈笑死我了",
	"前面的观众别刷屏",
	"求一个歌单",
	"今天播多久呀",
	"这把稳了稳了",
	"手速太快了看不清",
	"新观众报道一下",
	"主播的猫好可爱",
	"麦有点小听不清",
	"画质拉满了",
	"这局别浪稳住",
	"关注了关注了",
	"上次直播的梗还记得吗",
	"天气好热大家注意防暑",
	"求主播翻牌",
	"这个技能怎么放的",
	"我的天这也能过",
	"熬夜看直播值了",
	"主播喝口水休息一下",
	"弹幕好多哦",
	"路过的看看有没有活动",
	"这首歌我会唱",
	"什么时候开下一局",
	"今天粉丝涨了好多",
	"打卡打卡第三天",
	"操作细节值得学习",
	"好久没来了想念主播",
	"要不要试试新装备",
	"这个地图我也玩过",
	"主播讲讲思路呗",
	"哇塞好厉害",
	"评论区有人问链接",
	"周末快乐各位",
	"刚吃完饭来看",
	"节奏带得好",
	"今天的标题很有意思",
	"记得早点休息",
	"给主播点个赞",
	"下一个目标是什么",
	"直播间人越来越多了",
	"主播换个视角看看",
	"这段剪辑一定很精彩",
	"能不能再来一遍",
	"隔壁也在播同款",
	"最近有新活动吗",
	"感谢主播的陪伴",
	"弹幕互动好热闹",
	"主播的声音很好听",
	"这次一定能赢",
	"今晚吃什么好呢",
	"新手求带一把",
	"预告一下明天播吗",
	"这个结局猜到了",
	"截图留念",
	"礼物走一波",
	"看着看着就饿了",
	"技术流上线",
	"回放在哪里看",
];

function str(v: string | number | undefined, fallback: string): string {
	return v === undefined || v === "" ? fallback : String(v);
}

function num(v: string | number | undefined, fallback: number): number {
	return typeof v === "number" ? v : fallback;
}

export function liveEventScenarios(deps: RoomPickerDeps): DevScenarioDef[] {
	const danmaku: DevScenarioDef = {
		id: "live.danmaku",
		group: "event",
		title: "弹幕批量",
		desc: "往房间塞一批弹幕。默认 60 条 / 8 位发言人,刚好越过下播词云(50 个热词)与直播总结(5 位发言人)的门槛;给了 uid 就全由这一位发,拿来试「特别关注的弹幕」推送。房间得在(假)直播中才收。",
		icon: "chat",
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
			{ key: "count", label: "条数", kind: "number", default: 60, min: 1, max: 500 },
			{ key: "senders", label: "发言人数", kind: "number", default: 8, min: 1, max: 100 },
			{ key: "uid", label: "指定发言人 uid(可空)", kind: "text", default: "" },
		],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			const count = num(params.count, 60);
			const senders = num(params.senders, 8);
			const fixedUid = str(params.uid, "");
			if (fixedUid !== "" && !/^\d+$/.test(fixedUid)) throw new DevParamError("uid 得是数字");
			const now = Date.now();
			for (let i = 0; i < count; i++) {
				const user =
					fixedUid === ""
						? fakeUser(i % senders)
						: { uid: Number(fixedUid), uname: `特别关注${fixedUid}` };
				const content = `${DANMAKU_POOL[i % DANMAKU_POOL.length]}${i >= DANMAKU_POOL.length ? ` ${Math.floor(i / DANMAKU_POOL.length) + 1}` : ""}`;
				handle.inject({ kind: "danmu", content, user, timestamp: now + i });
			}
			const who = fixedUid === "" ? `${Math.min(senders, count)} 位假观众` : `uid ${fixedUid}`;
			return { summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了 ${count} 条弹幕(${who})。` };
		},
	};

	const superchat: DevScenarioDef = {
		id: "live.superchat",
		group: "event",
		title: "醒目留言",
		desc: "塞一条 SC。低于该 UP 的 minScPrice 会被过滤 —— 那正是要验的。",
		icon: "sc",
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
			{ key: "price", label: "金额(元)", kind: "number", default: 30, min: 1, max: 5000 },
			{ key: "text", label: "正文", kind: "text", default: "devtools 送来的醒目留言" },
			{ key: "uname", label: "发言人", kind: "text", default: "醒目留言测试员" },
		],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			const price = num(params.price, 30);
			handle.inject({
				kind: "superchat",
				content: str(params.text, "devtools 送来的醒目留言"),
				price,
				user: { uid: 900_100_001, uname: str(params.uname, "醒目留言测试员") },
				id: Date.now(),
				durationSec: price >= 100 ? 300 : 60,
			});
			return { summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了一条 ${price} 元的 SC。` };
		},
	};

	const GUARD: Record<string, { level: GuardLevel; name: string; price: number }> = {
		captain: { level: GuardLevel.Captain, name: "舰长", price: 198_000 },
		admiral: { level: GuardLevel.Admiral, name: "提督", price: 1_998_000 },
		governor: { level: GuardLevel.Governor, name: "总督", price: 19_998_000 },
	};

	const guard: DevScenarioDef = {
		id: "live.guard",
		group: "event",
		title: "上舰",
		desc: "塞一条大航海开通(GUARD_BUY)。低于该 UP 的 minGuardLevel 会被过滤。",
		icon: "guard",
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
			{
				key: "level",
				label: "等级",
				kind: "enum",
				options: [
					{ value: "captain", label: "舰长" },
					{ value: "admiral", label: "提督" },
					{ value: "governor", label: "总督" },
				],
				default: "captain",
			},
			{ key: "uname", label: "上舰的人", kind: "text", default: "上舰测试员" },
		],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			const g = GUARD[str(params.level, "captain")] ?? GUARD.captain;
			if (!g) throw new DevParamError("等级不认识");
			const now = Math.floor(Date.now() / 1000);
			handle.inject({
				kind: "guard-buy",
				guardLevel: g.level,
				giftName: g.name,
				user: { uid: 900_200_001, uname: str(params.uname, "上舰测试员") },
				price: g.price,
				num: 1,
				startTime: now,
				endTime: now + 30 * 86_400,
			});
			return { summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了一条开通${g.name}。` };
		},
	};

	const gift: DevScenarioDef = {
		id: "live.gift",
		group: "event",
		title: "礼物",
		desc: "塞一条送礼(SEND_GIFT)。业务层今天不消费礼物(只打协议层地基),它只算一次活跃度 —— 拿来验连接看门狗与协议解析。",
		icon: "gift",
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
			{ key: "name", label: "礼物名", kind: "text", default: "小心心" },
			{ key: "num", label: "数量", kind: "number", default: 1, min: 1, max: 999 },
			{ key: "uname", label: "送礼的人", kind: "text", default: "送礼测试员" },
		],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			const n = num(params.num, 1);
			handle.inject({
				kind: "gift",
				user: { uid: 900_300_001, uname: str(params.uname, "送礼测试员") },
				giftId: 30607,
				giftName: str(params.name, "小心心"),
				coinType: "gold",
				price: 5_000,
				num: n,
			});
			return {
				summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了 ${n} 个${str(params.name, "小心心")}。`,
			};
		},
	};

	const enter: DevScenarioDef = {
		id: "live.enter",
		group: "event",
		title: "进场",
		desc: "塞一条观众进场(INTERACT_WORD)。uid 省略时取这位 UP 的第一个特别关注 —— 只有在白名单里、且开着进场提醒,才会推。",
		icon: "user",
		params: [
			{ key: "sub", label: "订阅", kind: "sub" },
			{ key: "uid", label: "进场的 uid(可空)", kind: "text", default: "" },
			{ key: "uname", label: "昵称", kind: "text", default: "进场测试员" },
		],
		run(params) {
			const { sub, roomId, handle } = pickRoom(deps, params);
			const given = str(params.uid, "");
			const uid = given !== "" ? given : (sub.specialUsers?.[0] ?? "");
			if (uid === "") {
				throw new DevParamError(`${sub.name} 没配特别关注,得给一个 uid`);
			}
			if (!/^\d+$/.test(uid)) throw new DevParamError("uid 得是数字");
			handle.inject({
				kind: "user-action",
				action: "enter",
				user: { uid: Number(uid), uname: str(params.uname, "进场测试员") },
			});
			return { summary: `已向 ${sub.name} 的直播间 ${roomId} 塞了 uid ${uid} 的进场。` };
		},
	};

	return [danmaku, superchat, guard, gift, enter];
}
