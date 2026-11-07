import type { DevCapturedDelivery } from "@bilibili-notify/contract";
import type { DestinationRef, NotificationPayload } from "@bilibili-notify/internal";
import { ok } from "@bilibili-notify/internal";
import type { SendInterceptHandler } from "../push/target-dispatcher.js";

/**
 * D1 截流:推送出口(`TargetDispatcher` 调适配器 `send` 的那一处)上接一道闸。
 *
 * **默认真发**(主人拍板:默认真发 + 可截流)。闸开着时不真发、记一条摘要、回 `ok` ——
 * 历史照记 `delivered`,不打标(不为调试改 history schema);面板上这份截流列表才是对照,
 * 另有「清掉截流期间历史行」按钮按下面的时间窗删。
 *
 * 所有 adapter 共用一把闸:截流是「整个出口」的开关,不是逐平台的。
 */

/** 文本摘要最多留这么多字 —— 一整篇周报塞进面板列表只会把它撑爆。 */
const TEXT_LIMIT = 200;
/** 列表封顶;满了丢最旧的。dev-only,不落盘。 */
const ENTRY_CAP = 200;

interface CaptureWindow {
	from: number;
	/** null = 还开着。 */
	to: number | null;
}

export interface CaptureGate {
	enabled(): boolean;
	enable(): void;
	disable(): void;
	entries(): DevCapturedDelivery[];
	/** 拦下了几条。生效条上每几秒念一次,别为了一个数把整张表拷一遍。 */
	count(): number;
	clear(): void;
	/** 截流开着的那几段时间 —— 「清掉截流期间历史行」按它删。 */
	windows(): CaptureWindow[];
	/** 清完历史之后:已封口的窗丢掉,开着的那段从现在重新起算。 */
	resetWindows(): void;
	/** 交给 `TargetDispatcher` 的 `interceptSend`:闸开着时记一条、回结果,否则回 `undefined` 放行。 */
	intercept: SendInterceptHandler;
}

/** 不经目标表发送时没有目标 id,截流记录里用 `session:<scope>:<address>` 顶上。 */
function sessionKey(destination: DestinationRef): string {
	return destination.kind === "session"
		? `session:${destination.scope}:${destination.address}`
		: `endpoint:${destination.id}`;
}

function sessionLabel(destination: DestinationRef): string {
	return destination.kind === "session"
		? `${destination.scope === "group" ? "群" : "私聊"} ${destination.address}`
		: destination.name;
}

function clip(text: string): string {
	return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

/** 载荷 → 面板上那一行摘要。与 history store 的 `reduce` 是两回事:那边落盘,这边只给人看。 */
function summarize(payload: NotificationPayload): { text?: string; images: number } {
	switch (payload.kind) {
		case "text":
			return { text: clip(payload.text), images: 0 };
		case "image":
			return payload.caption === undefined
				? { images: 1 }
				: { text: clip(payload.caption), images: 1 };
		case "image-group":
			return { images: payload.images.length };
		case "native-share":
			return { text: clip(payload.title), images: 0 };
		case "composite": {
			const parts: string[] = [];
			let images = 0;
			for (const seg of payload.segments) {
				if (seg.kind === "text") parts.push(seg.text);
				else if (seg.kind === "image") images++;
				else if (seg.kind === "link") parts.push(seg.title ? `${seg.title} ${seg.href}` : seg.href);
				else if (seg.kind === "at-all") parts.push("@全体");
			}
			return parts.length === 0 ? { images } : { text: clip(parts.join("\n")), images };
		}
	}
}

export function createCaptureGate(reservedIntegrationKeys: readonly string[]): CaptureGate {
	let on = false;
	let seq = 0;
	let list: DevCapturedDelivery[] = [];
	let windows: CaptureWindow[] = [];

	const gate: CaptureGate = {
		enabled: () => on,
		enable() {
			if (on) return;
			on = true;
			windows.push({ from: Date.now(), to: null });
		},
		disable() {
			if (!on) return;
			on = false;
			const open = windows.at(-1);
			if (open && open.to === null) open.to = Date.now();
		},
		entries: () => [...list],
		count: () => list.length,
		clear() {
			list = [];
		},
		windows: () => windows.map((w) => ({ ...w })),
		resetWindows() {
			windows = on ? [{ from: Date.now(), to: null }] : [];
		},
		intercept({ connection, destination, target, payload }) {
			if (!on) return undefined;
			seq += 1;
			list.push({
				id: String(seq),
				at: Date.now(),
				connectionId: connection.id,
				connectionName: connection.name,
				// 平台名:内置的是它的平台,拓展连接保持拓展 id。
				platform: reservedIntegrationKeys.includes(connection.adapterKey)
					? connection.platform
					: connection.adapterKey,
				// 按会话坐标发的(没有目标表里的那条)拼一个会话标识,名字显示成「群 <地址>」/「私聊 <地址>」。
				targetId: target?.id ?? sessionKey(destination),
				targetName: target?.name ?? sessionLabel(destination),
				// 是否私聊由去向自己的 scope 算(原来的「强制私聊」路径已删)。
				private: destination.kind === "session" && destination.scope === "private",
				kind: payload.kind,
				...summarize(payload),
			});
			if (list.length > ENTRY_CAP) list = list.slice(list.length - ENTRY_CAP);
			// `isSynthetic` 是给上游看的:这条没出网,别拿它去翻 target.reachability(那是会落盘的)。
			return ok({ latencyMs: 0, isSynthetic: true as const });
		},
	};
	return gate;
}
