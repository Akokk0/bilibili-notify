/**
 * protobuf wire 走查器(诊断工具):不依赖任何 .proto schema,直接按 wire
 * format 走查一段 protobuf 的字段号 / wire 类型 / 值,嵌套消息递归展开。
 *
 * 为什么存在:本包的 SEND_GIFT_V2 / INTERACT_WORD_V2 schema 是手裁的,而
 * protobufjs 对字段号漂移**不报错**,会安静解出错值(price 变 0、uid 错位)。
 * 怀疑漂移时,拿真帧(capture 蹲到的 data.pb)走查一遍,和 schema 声明的
 * 字段号对账 —— 2026-08 SEND_GIFT_V2 的字段号就是这么独立验证的。
 *
 * 用法(仓库根目录):
 *   node --experimental-transform-types packages/blive/scripts/pb-walk.ts <base64>
 *   node --experimental-transform-types packages/blive/scripts/pb-walk.ts --fixture giftV2
 *   echo "<base64>" | node --experimental-transform-types packages/blive/scripts/pb-walk.ts -
 *
 * `--fixture <key>` 直接取 src/__tests__/fixtures/payloads.json 里该 key 的
 * data.pb,拿已钉测试的帧对照输出格式最方便。
 *
 * 输出里 length-delimited 字段会尝试三种解读:合法嵌套消息(递归展开)/
 * UTF-8 字符串 / 十六进制;消息与字符串同时成立时两种都打出来 —— wire
 * format 本身有歧义,判断交给人。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;
const MAX_DEPTH = 8;

function readVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } | null {
	let value = 0n;
	let shift = 0n;
	for (let i = pos; i < buf.length && i - pos < 10; i++) {
		const b = buf[i] as number;
		value |= BigInt(b & 0x7f) << shift;
		if ((b & 0x80) === 0) return { value, next: i + 1 };
		shift += 7n;
	}
	return null;
}

interface Field {
	num: number;
	wire: number;
	/** varint / fixed 的数值;len 字段为 undefined。 */
	value?: bigint;
	/** len 字段的字节切片。 */
	bytes?: Uint8Array;
}

/** 严格走查:整段必须被合法字段序列精确吃完,否则判定「不是消息」返回 null。 */
function tryWalk(buf: Uint8Array): Field[] | null {
	const fields: Field[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const tag = readVarint(buf, pos);
		if (!tag) return null;
		const num = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);
		if (num < 1 || num > 536870911) return null;
		pos = tag.next;
		if (wire === WIRE_VARINT) {
			const v = readVarint(buf, pos);
			if (!v) return null;
			fields.push({ num, wire, value: v.value });
			pos = v.next;
		} else if (wire === WIRE_FIXED64) {
			if (pos + 8 > buf.length) return null;
			const view = new DataView(buf.buffer, buf.byteOffset + pos, 8);
			fields.push({ num, wire, value: view.getBigUint64(0, true) });
			pos += 8;
		} else if (wire === WIRE_FIXED32) {
			if (pos + 4 > buf.length) return null;
			const view = new DataView(buf.buffer, buf.byteOffset + pos, 4);
			fields.push({ num, wire, value: BigInt(view.getUint32(0, true)) });
			pos += 4;
		} else if (wire === WIRE_LEN) {
			const len = readVarint(buf, pos);
			if (!len) return null;
			const start = len.next;
			const end = start + Number(len.value);
			if (end > buf.length) return null;
			fields.push({ num, wire, bytes: buf.subarray(start, end) });
			pos = end;
		} else {
			return null; // wiretype 3/4(group,已废弃)与非法值一律不认
		}
	}
	return fields;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** 可打印 UTF-8:严格解码成功且不含控制字符(\n \t 除外)。 */
function asPrintable(bytes: Uint8Array): string | undefined {
	try {
		const s = utf8Strict.decode(bytes);
		const hasControl = [...s].some((ch) => {
			const c = ch.codePointAt(0) as number;
			return (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f;
		});
		return hasControl ? undefined : s;
	} catch {
		return undefined;
	}
}

function hexPreview(bytes: Uint8Array): string {
	const head = Buffer.from(bytes.subarray(0, 24)).toString("hex");
	return bytes.length > 24 ? `${head}…(${bytes.length}B)` : head;
}

function print(buf: Uint8Array, indent: string, depth: number): void {
	const fields = tryWalk(buf);
	if (!fields) {
		console.log(`${indent}(非法 wire 序列)${hexPreview(buf)}`);
		return;
	}
	for (const f of fields) {
		if (f.wire === WIRE_VARINT) {
			console.log(`${indent}#${f.num} varint = ${f.value}`);
		} else if (f.wire === WIRE_FIXED64) {
			const view = new DataView(new BigUint64Array([f.value as bigint]).buffer);
			console.log(`${indent}#${f.num} fixed64 = ${f.value}(double ${view.getFloat64(0, true)})`);
		} else if (f.wire === WIRE_FIXED32) {
			const view = new DataView(new Uint32Array([Number(f.value)]).buffer);
			console.log(`${indent}#${f.num} fixed32 = ${f.value}(float ${view.getFloat32(0, true)})`);
		} else if (f.bytes) {
			const text = asPrintable(f.bytes);
			const nested = depth < MAX_DEPTH && f.bytes.length > 0 ? tryWalk(f.bytes) : null;
			if (nested && text !== undefined) {
				// 歧义:两种解读都合法,都打出来交给人判断
				console.log(
					`${indent}#${f.num} len(${f.bytes.length}) 可作字符串 = ${JSON.stringify(text)}`,
				);
				console.log(`${indent}#${f.num} len(${f.bytes.length}) 亦可作嵌套消息:`);
				print(f.bytes, `${indent}  `, depth + 1);
			} else if (nested) {
				console.log(`${indent}#${f.num} len(${f.bytes.length}) 嵌套消息:`);
				print(f.bytes, `${indent}  `, depth + 1);
			} else if (text !== undefined) {
				console.log(`${indent}#${f.num} len(${f.bytes.length}) 字符串 = ${JSON.stringify(text)}`);
			} else {
				console.log(`${indent}#${f.num} len(${f.bytes.length}) bytes = ${hexPreview(f.bytes)}`);
			}
		}
	}
}

// ── 入口:base64 / --fixture <key> / stdin ──────────────────────

let b64: string;
const arg = process.argv[2];
if (!arg) {
	console.error("用法: pb-walk.ts <base64 | - | --fixture <key>>");
	process.exit(1);
} else if (arg === "--fixture") {
	const key = process.argv[3];
	const file = fileURLToPath(new URL("../src/__tests__/fixtures/payloads.json", import.meta.url));
	const payloads = JSON.parse(readFileSync(file, "utf8")) as Record<
		string,
		{ data?: { pb?: string } }
	>;
	const pb = key ? payloads[key]?.data?.pb : undefined;
	if (!pb) {
		console.error(
			`fixture ${key ?? "?"} 不存在或没有 data.pb;可选:${Object.keys(payloads).join(", ")}`,
		);
		process.exit(1);
	}
	b64 = pb;
} else if (arg === "-") {
	b64 = readFileSync(0, "utf8").trim();
} else {
	b64 = arg.trim();
}

const bytes = new Uint8Array(Buffer.from(b64, "base64"));
if (bytes.length === 0) {
	console.error("base64 解出来是空的");
	process.exit(1);
}
console.log(`${bytes.length} 字节:`);
print(bytes, "  ", 0);
