/**
 * 由字符串种子生成 v4-shape 的稳定 UUID(djb2 / Math.imul 哈希散到 16 字节)。
 * 不是密码学安全;只用作 reload 跨次稳定 id 的种子。
 *
 * 每一步都 `>>> 0` 保证 JS 位运算不会把负数喂给 `toString(16)`(会输出 `-` 破坏 UUID 形)。
 */
export function deterministicUuid(input: string): string {
	let h1 = 5381;
	let h2 = 52711;
	let h3 = 0xdeadbeef;
	let h4 = 0xbaddcafe;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = (Math.imul(h1, 33) ^ c) >>> 0;
		h2 = (Math.imul(h2, 37) ^ c) >>> 0;
		h3 = (Math.imul(h3, 31) ^ c) >>> 0;
		h4 = (Math.imul(h4, 29) ^ c) >>> 0;
	}
	const toHex = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, "0").slice(-len);
	const seg1 = toHex(h1, 8);
	const seg2 = toHex((h2 >>> 0) & 0xffff, 4);
	const seg3 = `4${toHex(((h3 >>> 0) >>> 4) & 0x0fff, 3)}`; // version 4
	const seg4 = toHex((((h4 >>> 0) >>> 4) & 0x3fff) | 0x8000, 4); // RFC 4122 variant
	const seg5a = toHex((h1 ^ h2) >>> 0, 8);
	const seg5b = toHex(((h3 ^ h4) >>> 0) & 0xffff, 4);
	return `${seg1}-${seg2}-${seg3}-${seg4}-${seg5a}${seg5b}`;
}
