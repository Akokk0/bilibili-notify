import { isIP } from "node:net";
import { fail, ok, type Result } from "@bilibili-notify/internal/constants";

/**
 * 这个地址是不是公网地址 —— 抓图那一层拦内网(防 SSRF)用的判定,`FetchOptions.addressCheck` 的生产默认实现。
 *
 * 只看 **IP 字面量**:主机名要先解析,判的是解析出来的地址。判定挂在「真正建连接用的那一次解析」上
 * (`HttpClient` 的守卫连接函数),所以没有「检查时一个地址、连接时另一个」的重绑定窗口。
 *
 * 拦的段:
 * - IPv4:`0.0.0.0/8`(本机网络)、`10/8` `172.16/12` `192.168/16`(RFC1918)、`100.64/10`(CGNAT)、`127/8`(回环)、
 *   `169.254/16`(链路本地,云的元数据口就在这里)、`192.0.0/24`(IETF 协议保留)、`192.0.2/24` `198.51.100/24`
 *   `203.0.113/24`(文档段)、`198.18/15`(基准测试,常被内网挪用)、`224/4`(组播)、`240/4`(保留,含广播)。
 * - IPv6:`::`、`::1`、`::/96`(v4 兼容,已废弃)、`64:ff9b:1::/48`(本地用 NAT64)、`2001::/32`(Teredo)、
 *   `2001:db8::/32`(文档段)、`fc00::/7`(ULA)、`fe80::/10`(链路本地)、`fec0::/10`(站点本地,已废弃)、`ff00::/8`(组播)。
 * - IPv6 里嵌着 IPv4 的按里面的 v4 判,否则绕得过上面的 v4 清单:`::ffff:a.b.c.d`(v4 映射)、`64:ff9b::/96`(NAT64)、
 *   `2002::/16`(6to4)。
 */
export function requirePublicAddress(address: string): Result {
	const literal = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
	const family = isIP(literal);
	if (family === 4) {
		const octets = literal.split(".").map(Number);
		return isReservedIPv4(octets) ? refuse(address) : ok();
	}
	if (family === 6) {
		const bytes = bytesOfIPv6(literal);
		const embedded = embeddedIPv4(bytes);
		if (embedded) return isReservedIPv4(embedded) ? refuse(address) : ok();
		return isReservedIPv6(bytes) ? refuse(address) : ok();
	}
	return fail("invalid", `不是 IP 地址: ${address}`);
}

function refuse(address: string): Result {
	return fail("invalid", `内网或保留地址,不连: ${address}`);
}

function isReservedIPv4([a = 0, b = 0, c = 0]: readonly number[]): boolean {
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b === 51 && c === 100) return true;
	if (a === 203 && b === 0 && c === 113) return true;
	return a >= 224;
}

/** IPv6 字面量(`isIP` 已认过)→ 16 个字节。区号(`%en0`)不参与判定;末尾可以是点分的 IPv4。 */
function bytesOfIPv6(literal: string): number[] {
	const [address = ""] = literal.split("%");
	const groupsOf = (part: string): number[] => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			if (piece.includes(".")) {
				const [a = 0, b = 0, c = 0, d = 0] = piece.split(".").map(Number);
				groups.push((a << 8) | b, (c << 8) | d);
			} else {
				groups.push(Number.parseInt(piece, 16));
			}
		}
		return groups;
	};
	const [head = "", tail] = address.split("::");
	const front = groupsOf(head);
	const back = tail === undefined ? [] : groupsOf(tail);
	const groups = [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
	return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

/** 嵌在 IPv6 里的 IPv4(v4 映射、NAT64、6to4);不是这几种回 `undefined`。 */
function embeddedIPv4(bytes: readonly number[]): number[] | undefined {
	const startsWith = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
	// ::ffff:a.b.c.d
	if (startsWith(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff)) return bytes.slice(12);
	// 64:ff9b::a.b.c.d
	if (startsWith(0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0)) return bytes.slice(12);
	// 2002:AABB:CCDD::
	if (startsWith(0x20, 0x02)) return bytes.slice(2, 6);
	return undefined;
}

function isReservedIPv6(bytes: readonly number[]): boolean {
	const [b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0] = bytes;
	// ::/96:未指定、回环、v4 兼容。
	if (bytes.slice(0, 12).every((byte) => byte === 0)) return true;
	// 64:ff9b:1::/48
	if (b0 === 0 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b && b4 === 0 && b5 === 1) return true;
	// 2001::/32 与 2001:db8::/32
	if (b0 === 0x20 && b1 === 0x01 && ((b2 === 0 && b3 === 0) || (b2 === 0x0d && b3 === 0xb8))) {
		return true;
	}
	// fc00::/7
	if ((b0 & 0xfe) === 0xfc) return true;
	// fe80::/10 与 fec0::/10
	if (b0 === 0xfe && (b1 & 0x80) === 0x80) return true;
	// ff00::/8
	return b0 === 0xff;
}
