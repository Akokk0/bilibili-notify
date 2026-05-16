import { randomBytes } from "node:crypto";

/**
 * 一次性短时 WS 鉴权 ticket 存储。
 *
 * 为什么需要这个:浏览器 `new WebSocket(url)` 不能附加 `Authorization` 头,只能往
 * URL 里塞东西。但是把 basic-auth 的 base64 凭证直接塞 URL 会被 nginx 等反代日志
 * 记下来 — 凭证泄漏。
 *
 * 解决:basic-auth 通过的 REST 请求(`POST /api/auth/ws-ticket`)签发一次性 token,
 * 客户端用 `?ticket=<xxx>` 完成 WS upgrade。ticket 在内存 Set,TTL 短(默认 30 秒),
 * 一旦被 `consume()` 立刻删除 — 即使 ticket 出现在反代日志里,它也已经过期或被用过了。
 */
export interface WsTicketStore {
	issue(): { ticket: string; expiresInMs: number };
	consume(ticket: string): boolean;
	dispose(): void;
}

interface CreateOptions {
	/** 单个 ticket 有效时长,默认 30s。 */
	ttlMs?: number;
}

export function createWsTicketStore(opts: CreateOptions = {}): WsTicketStore {
	const ttlMs = opts.ttlMs ?? 30_000;
	const tickets = new Map<string, number>(); // ticket → expiresAt epoch ms

	// 周期性回收过期 ticket,避免 Map 无限增长 — 一次 sweep 复杂度 O(n) 但 n 很小。
	// WT1:先把 Timeout 句柄存下来再 unref —— 旧写法 `setInterval(...).unref?.()`
	// 把 unref() 的返回值(可能是 undefined / 非句柄)赋给 sweepHandle,导致
	// dispose() 根本拿不到句柄去 clearInterval(实际旧 dispose 也没 clear),
	// sweep 定时器永久泄漏。
	const sweepHandle = setInterval(() => {
		const now = Date.now();
		for (const [t, expires] of tickets) {
			if (expires <= now) tickets.delete(t);
		}
	}, ttlMs);
	// .unref() 不阻塞 process.exit;某些 ws polyfill 没有 unref,容错处理。
	(sweepHandle as { unref?: () => void }).unref?.();

	return {
		issue() {
			const ticket = randomBytes(24).toString("base64url");
			tickets.set(ticket, Date.now() + ttlMs);
			return { ticket, expiresInMs: ttlMs };
		},
		consume(ticket) {
			const expires = tickets.get(ticket);
			if (expires === undefined) return false;
			tickets.delete(ticket); // one-shot
			return expires > Date.now();
		},
		dispose() {
			clearInterval(sweepHandle);
			tickets.clear();
		},
	};
}
