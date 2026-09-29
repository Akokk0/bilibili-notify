import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

/**
 * 测试拦外网:vitest 运行里连向非本机地址的连接、查外网名字的 DNS 查询一律拦下,只放行本机
 * (回环地址与 unix socket)。
 *
 * 连接挂一处:`net.Socket.prototype.connect`。fetch(Node 自带的 undici)、`http` / `https`、
 * `ws`、全局 WebSocket、`tls.connect` 最后都落到它 —— 挂 `net.connect` 不够,`http` 的
 * Agent 在模块加载时就把 `net.createConnection` 抄走了。拦法仿「连接被拒」:下一拍 destroy
 * 并带上错误,调用方原有的 error 处理照常触发。
 *
 * DNS 另挂:只解析、不连接也会往外发查询(拦内网之类要先解析再比地址的代码就是这样)。
 * 连接那一处管不到它 —— 连外网名字时连接先被拦下,轮不到解析;直接调解析的根本不经过连接。
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

/**
 * DNS 的四处入口各挂一遍:模块上的 `resolve*` / `reverse` 是默认解析器的绑定副本,和
 * `Resolver.prototype` 上的不是同一个函数;promises 那一侧同样两处(`node:dns/promises` 就是
 * `dns.promises`)。`lookup` 放行本机名与 IP 字面量(字面量 Node 直接返回,不发查询),其余只放行本机。
 * 第一个参数不是字符串的交回原函数,让 Node 自己的参数校验报错。
 *
 * 换掉的是 CJS 导出对象上的属性,ESM 的具名导入(`import { lookup } from "node:dns"`)读的是另一份
 * 快照,要 `syncBuiltinESMExports()` 才跟上。
 */
function guardDns(blocked) {
	const methods = Object.getOwnPropertyNames(dns.Resolver.prototype).filter(
		(name) => name !== "constructor",
	);
	const allowed = (name, host) =>
		isLoopbackHost(host) || (name === "lookup" && net.isIP(host) !== 0);
	const refuse = (host) => {
		const err = new Error(
			`测试里不许查外网名字:${host}(DNS)。只放行本机地址,要解析的逻辑请注入解析函数或换成 mock`,
		);
		err.code = BLOCKED_CODE;
		blocked.push({ target: `dns:${host}`, stack: new Error().stack });
		return err;
	};
	const wrapCallback = (name, original) =>
		function guardedDnsCall(...args) {
			const [host] = args;
			const callback = args.at(-1);
			if (typeof host !== "string" || typeof callback !== "function" || allowed(name, host)) {
				return original.apply(this, args);
			}
			const err = refuse(host);
			process.nextTick(() => callback(err));
		};
	const wrapPromise = (name, original) =>
		function guardedDnsQuery(...args) {
			const [host] = args;
			if (typeof host !== "string" || allowed(name, host)) return original.apply(this, args);
			return Promise.reject(refuse(host));
		};
	for (const [target, wrap] of [
		[dns.Resolver.prototype, wrapCallback],
		[dns.promises.Resolver.prototype, wrapPromise],
	]) {
		for (const name of methods) target[name] = wrap(name, target[name]);
	}
	for (const [target, wrap] of [
		[dns, wrapCallback],
		[dns.promises, wrapPromise],
	]) {
		for (const name of [...methods, "lookup", "lookupService"])
			target[name] = wrap(name, target[name]);
	}
	syncBuiltinESMExports();
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
	guardDns(blocked);
	const guard = { drain: () => blocked.splice(0) };
	globalThis[GUARD] = guard;
	return guard;
}
