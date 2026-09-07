import type { DevCapturedDelivery } from "@bilibili-notify/contract";
import type { NotificationPayload } from "@bilibili-notify/internal";
import type { PlatformAdapter } from "../platforms/types.js";

/**
 * D1 截流:推送出口(`PlatformAdapter.send`)外面套一层闸。
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

export interface CaptureWindow {
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
	wrap(inner: PlatformAdapter): PlatformAdapter;
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
		case "forward-images":
			return { images: payload.images.length };
		case "miniapp-card":
			return { text: clip(payload.title), images: 0 };
		case "composite": {
			const parts: string[] = [];
			let images = 0;
			for (const seg of payload.segments) {
				if (seg.type === "text") parts.push(seg.text);
				else if (seg.type === "image") images++;
				else if (seg.type === "link") parts.push(seg.title ? `${seg.title} ${seg.href}` : seg.href);
				else if (seg.type === "at-all") parts.push("@全体");
			}
			return parts.length === 0 ? { images } : { text: clip(parts.join("\n")), images };
		}
	}
}

export function createCaptureGate(): CaptureGate {
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
		wrap(inner) {
			// 展开而不是逐个转发:可选方法有就有、没有就没有(sink 与能力探测按「方法在不在」判
			// 「这个平台有没有这个概念」),接口多一个方法这里也不用跟。前提是 adapter 的方法不吃
			// `this`,那条写在 PlatformAdapter 的文档上。
			return {
				...inner,
				async send(adapter, target, payload, opts) {
					if (!on) return inner.send(adapter, target, payload, opts);
					seq += 1;
					list.push({
						id: String(seq),
						at: Date.now(),
						adapterId: adapter.id,
						adapterName: adapter.name,
						platform: adapter.platform,
						targetId: target.id,
						targetName: target.name,
						private: opts?.private === true,
						kind: payload.kind,
						...summarize(payload),
					});
					if (list.length > ENTRY_CAP) list = list.slice(list.length - ENTRY_CAP);
					// `synthetic` 是给上游看的:这条没出网,别拿它去翻 target.testStatus(那是会落盘的)。
					return { ok: true, latencyMs: 0, synthetic: true };
				},
			};
		},
	};
	return gate;
}
