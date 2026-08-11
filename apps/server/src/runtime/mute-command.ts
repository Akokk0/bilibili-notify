/**
 * `/mute` —— 「安静一会儿」。
 *
 * 状态与闸门都在别处({@link ./mute-state.js} 判到期,`BilibiliPush.broadcastToFeature`
 * 挡推送),这里只剩指令这一层:改状态,然后把「几点恢复」说清楚。
 *
 * 那句回复不是客套。静音是个**无声**的状态 —— 主人过一会儿发现没推送,分不清是自己
 * 静音了还是系统挂了,而这两件事的处理方式完全相反。把恢复时刻印在回复里,他往上翻
 * 一条就能确认。
 */

import { type CommandSpec, command } from "./command-dispatcher.js";
import type { MuteState } from "./mute-state.js";

export interface MuteCommandOptions {
	muteState: MuteState;
	/** 回一句话给主人。 */
	reply: (text: string) => Promise<void>;
	/** 可注入的时钟。测试用,生产不传。 */
	now?: () => number;
}

/**
 * 把恢复时刻说成人话。
 *
 * 跨天时必须带上日期 —— 「04:00 恢复」会被读成今天凌晨 4 点,而那是**已经过去**的
 * 时刻,主人会以为静音压根没生效。
 */
function describeUntil(until: number, now: number): string {
	const end = new Date(until);
	const hhmm = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	const sameDay =
		end.getFullYear() === today.getFullYear() &&
		end.getMonth() === today.getMonth() &&
		end.getDate() === today.getDate();
	return sameDay ? hhmm : `${end.getMonth() + 1} 月 ${end.getDate()} 日 ${hhmm}`;
}

export function createMuteCommand(opts: MuteCommandOptions): CommandSpec {
	const now = opts.now ?? Date.now;
	return command({
		name: "mute",
		aliases: ["静音", "免打扰"],
		signature: "<duration:duration|时长>",
		description: "安静一会儿，到点自动恢复",
		// 静音挡的是订阅推送。另外两条路不归它管,而这两条都会在静音期间真的响 ——
		// 主人不知道的话,只会以为静音坏了。
		details: "挡的是订阅推送。定时周报和锐评到点照发，出错也还是会叫你。",
		run: async (values) => {
			const until = await opts.muteState.muteFor(values.duration);
			if (until === 0) {
				await opts.reply("好啦，已经恢复推送了～");
				return;
			}
			// 顺带交代一句「出错还是会叫你」:告警走的是私聊,不归静音管。不说的话,
			// 主人静音期间收到一条报错会以为静音坏了。
			await opts.reply(`好的，${describeUntil(until, now())} 之前不打扰你～（出错了还是会叫你的）`);
		},
	});
}
