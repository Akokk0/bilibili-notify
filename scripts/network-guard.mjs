import net from "node:net";

/**
 * 测试拦外网:vitest 运行里连向非本机地址的连接一律拦下,只放行本机(回环地址与 unix socket)。
 *
 * 只挂一处:`net.Socket.prototype.connect`。fetch(Node 自带的 undici)、`http` / `https`、
 * `ws`、全局 WebSocket、`tls.connect` 最后都落到它 —— 挂 `net.connect` 不够,`http` 的
 * Agent 在模块加载时就把 `net.createConnection` 抄走了。
 *
 * 拦法仿「连接被拒」:下一拍 destroy 并带上错误,调用方原有的 error 处理照常触发。
 */

export const BLOCKED_CODE = "BN_TEST_NETWORK_BLOCKED";

const GUARD = Symbol.for("bilibili-notify.test-network-guard");

/** 缺省主机(Node 缺省连 localhost)、localhost、127.0.0.0/8、::1,以及监听在全部地址上的 `0.0.0.0` / `::`。 */
export function isLoopbackHost(host) {
	if (host === undefined || host === null || host === "") return true;
	const h = String(host).toLowerCase();
	if (h === "localhost" || h === "::1" || h === "::" || h === "0.0.0.0") return true;
	const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
	return net.isIPv4(v4) && v4.startsWith("127.");
}

/**
 * `Socket#connect` 接受三种写法:`(options)`、`(path)`、`(port, host?)`;
 * 经 `net.connect` 进来的是已规整好的 `[options, cb]` 数组。
 * 是不是 unix socket 照 Node 自己的判法看 path 真不真 —— `http` 传进来的选项带着 `path: null`。
 */
function targetOf(args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (first !== null && typeof first === "object") {
		return { isPipe: Boolean(first.path), host: first.host, port: first.port };
	}
	if (typeof first === "string" && Number.isNaN(Number(first))) return { isPipe: true };
	return { isPipe: false, host: typeof args[1] === "string" ? args[1] : undefined, port: first };
}

/**
 * 查账:有被拦的连接就抛错。被测代码把拦截的报错吞了(重试 / 回落 / 只记日志)时,测试本身
 * 照样绿,只有这一步能把它判红。调用栈只留项目自己的帧(去掉 Node 内部、依赖包与守卫本身);
 * fetch 是异步发起的,可能一帧都不剩,那就只能靠测试名与目标地址找。
 */
export function assertNoBlockedConnections(blocked) {
	if (blocked.length === 0) return;
	const lines = blocked.map(({ target, stack }) => {
		const frames = stack
			.split("\n")
			.slice(1)
			.filter((l) => !/node:|node_modules|network-guard\.mjs/.test(l))
			.slice(0, 5);
		return [`  - ${target}`, ...frames.map((f) => `    ${f.trim()}`)].join("\n");
	});
	throw new Error(`测试连了外网(已拦下;被测代码吞掉了报错也照样判失败):\n${lines.join("\n")}`);
}

/** 本进程的守卫,首次调用时装上。setupFiles 每个测试文件都会重跑,装过就复用,不叠第二层。 */
export function networkGuard() {
	if (globalThis[GUARD]) return globalThis[GUARD];
	const blocked = [];
	const originalConnect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function guardedConnect(...args) {
		const { isPipe, host, port } = targetOf(args);
		if (isPipe || isLoopbackHost(host)) return originalConnect.apply(this, args);
		const target = `${host}:${port}`;
		const err = new Error(
			`测试里不许连外网:${target}。只放行本机地址,要联网的逻辑请换成 mock 或本机假服务`,
		);
		err.code = BLOCKED_CODE;
		blocked.push({ target, stack: new Error().stack });
		process.nextTick(() => this.destroy(err));
		return this;
	};
	const guard = { drain: () => blocked.splice(0) };
	globalThis[GUARD] = guard;
	return guard;
}
