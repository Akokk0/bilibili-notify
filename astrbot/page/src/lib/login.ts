const DATA_URL_PREFIX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/=]+$/;
const MIN_BASE64_LENGTH = 32;

export function loginQrImageSrc(data: unknown): string | undefined {
	if (typeof data !== "string") return undefined;
	const value = data.trim();
	if (!value) return undefined;
	if (DATA_URL_PREFIX.test(value)) return value;
	if (!looksLikeImageBase64(value)) return undefined;
	const mime = detectImageMimeType(value);
	return mime ? `data:image/${mime};base64,${value}` : undefined;
}

export function loginResponseSummary(data: unknown): string | undefined {
	if (loginQrImageSrc(data)) return undefined;
	if (data == null) return undefined;
	try {
		return JSON.stringify(data, null, 2);
	} catch {
		return String(data);
	}
}

function looksLikeImageBase64(value: string): boolean {
	if (value.length < MIN_BASE64_LENGTH || value.length % 4 !== 0) return false;
	if (!BASE64_BODY.test(value)) return false;
	return detectImageMimeType(value) !== undefined;
}

function detectImageMimeType(value: string): "png" | "jpeg" | "webp" | "gif" | undefined {
	const bytes = decodeBase64(value);
	if (!bytes || bytes.length < 12) return undefined;
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
		return "png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpeg";
	}
	if (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x39 || bytes[4] === 0x37) &&
		bytes[5] === 0x61
	) {
		return "gif";
	}
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "webp";
	}
	return undefined;
}

function decodeBase64(value: string): Uint8Array | undefined {
	try {
		const globalAtob = globalThis.atob;
		if (typeof globalAtob !== "function") return undefined;
		const binary = globalAtob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return undefined;
	}
}
