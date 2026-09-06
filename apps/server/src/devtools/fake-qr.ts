import { deflateSync } from "node:zlib";

/**
 * 一张看得出是假的「二维码」:棋盘格 PNG,`data:` URL,给扫码登录假状态当占位。
 * 手工拼 PNG 而不是拉库:只要一张能显示出来的图,不值得为它进一个依赖。
 */

const SIZE = 29;
const SCALE = 6;

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

/** 像素规则:三个角画定位框,其余按伪随机撒点 —— 远看像二维码,近看是 devtools 的假货。 */
function black(x: number, y: number): boolean {
	const finder = (ox: number, oy: number) => {
		const dx = x - ox;
		const dy = y - oy;
		if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
		const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
		return ring === 3 || ring <= 1;
	};
	const f = finder(0, 0) ?? finder(SIZE - 7, 0) ?? finder(0, SIZE - 7);
	if (f !== null) return f;
	return ((x * 7 + y * 13 + ((x * y) % 5)) & 3) === 0;
}

let cached: string | null = null;

export function fakeQrDataUrl(): string {
	if (cached) return cached;
	const width = SIZE * SCALE;
	const rows: Buffer[] = [];
	for (let py = 0; py < width; py++) {
		const row = Buffer.alloc(1 + width);
		row[0] = 0;
		for (let px = 0; px < width; px++) {
			row[1 + px] = black(Math.floor(px / SCALE), Math.floor(py / SCALE)) ? 0 : 255;
		}
		rows.push(row);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(width, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // grayscale
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
	cached = `data:image/png;base64,${png.toString("base64")}`;
	return cached;
}
