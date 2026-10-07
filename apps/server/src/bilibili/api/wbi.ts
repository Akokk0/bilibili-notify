import { createHmac } from "node:crypto";
import md5 from "md5";

// Bilibili WBI signing constant table
const MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
	14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
	21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export interface WbiKeys {
	imgKey: string;
	subKey: string;
}

function getMixinKey(orig: string): string {
	return MIXIN_KEY_ENC_TAB.map((n) => orig[n])
		.join("")
		.slice(0, 32);
}

export function encWbi(params: Record<string, string | number | object>, keys: WbiKeys): string {
	const mixinKey = getMixinKey(keys.imgKey + keys.subKey);
	const wts = Math.floor(Date.now() / 1000);
	const chrFilter = /[!'()*]/g;

	const allParams: Record<string, unknown> = { ...params, wts };
	const query = Object.keys(allParams)
		.sort()
		.map((key) => {
			const raw = allParams[key];
			// P2:对象/数组值此前 String()→"[object Object]" 静默进签名,签名必错
			// 却无任何线索。显式抛错把误用暴露在调用点(query 参数只应是标量)。
			if (raw !== null && typeof raw === "object") {
				throw new Error(`encWbi: 参数 "${key}" 为对象/数组,query 参数只接受标量`);
			}
			const value = String(raw).replace(chrFilter, "");
			return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
		})
		.join("&");

	const wbiSign = md5(query + mixinKey);
	return `${query}&w_rid=${wbiSign}`;
}

function hmacSha256(key: string, message: string): string {
	return createHmac("sha256", key).update(message).digest("hex");
}

/**
 * Generate Bilibili ticket's HMAC-signed timestamp payload.
 * key_id: "ec02", secret: "XgwSnGZ1p"
 */
export function buildTicketParams(csrf?: string): URLSearchParams {
	const ts = Math.floor(Date.now() / 1000);
	const hexSign = hmacSha256("XgwSnGZ1p", `ts${ts}`);
	return new URLSearchParams({
		key_id: "ec02",
		hexsign: hexSign,
		"context[ts]": ts.toString(),
		csrf: csrf ?? "",
	});
}
