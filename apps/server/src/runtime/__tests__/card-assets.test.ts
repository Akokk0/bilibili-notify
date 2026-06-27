import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	cardBgDir,
	isValidCardBgId,
	listCardBg,
	readCardBg,
	readCardBgDataUrl,
	saveCardBg,
} from "../card-assets";

let dir: string;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "card-bg-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("card-assets", () => {
	it("saves a PNG and round-trips its bytes + mime", async () => {
		const id = await saveCardBg(dir, PNG, "image/png");
		expect(isValidCardBgId(id)).toBe(true);
		expect(id.endsWith(".png")).toBe(true);
		const read = await readCardBg(dir, id);
		expect(read?.mime).toBe("image/png");
		expect(read?.bytes.equals(Buffer.from(PNG))).toBe(true);
	});

	it("maps jpeg/webp mime to the right extension", async () => {
		expect(await saveCardBg(dir, PNG, "image/jpeg")).toMatch(/\.jpg$/);
		expect(await saveCardBg(dir, PNG, "image/webp")).toMatch(/\.webp$/);
	});

	it("rejects a non-image mime", async () => {
		await expect(saveCardBg(dir, PNG, "application/pdf")).rejects.toThrow();
	});

	it("rejects an oversized image", async () => {
		const big = new Uint8Array(5 * 1024 * 1024 + 1);
		await expect(saveCardBg(dir, big, "image/png")).rejects.toThrow();
	});

	it("rejects path-traversal / malformed ids", () => {
		expect(isValidCardBgId("../../etc/passwd")).toBe(false);
		expect(isValidCardBgId("abc.png")).toBe(false); // not 32 hex
		expect(isValidCardBgId("../secrets/config.enc")).toBe(false);
		expect(isValidCardBgId(`${"a".repeat(32)}.gif`)).toBe(false);
	});

	it("readCardBg returns null for an invalid id (no disk read)", async () => {
		expect(await readCardBg(dir, "../../secrets.json")).toBeNull();
	});

	it("listCardBg returns only valid stored ids, ignoring junk files", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "card-bg-list-"));
		try {
			const id1 = await saveCardBg(fresh, PNG, "image/png");
			const id2 = await saveCardBg(fresh, PNG, "image/webp");
			// junk that must be filtered out by the id gate
			await writeFile(join(cardBgDir(fresh), "not-an-asset.txt"), "x");
			await writeFile(join(cardBgDir(fresh), "deadbeef.png"), "x"); // not 32-hex
			expect(new Set(await listCardBg(fresh))).toEqual(new Set([id1, id2]));
		} finally {
			await rm(fresh, { recursive: true, force: true });
		}
	});

	it("listCardBg returns [] when the dir does not exist yet", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "card-bg-empty-"));
		try {
			expect(await listCardBg(fresh)).toEqual([]);
		} finally {
			await rm(fresh, { recursive: true, force: true });
		}
	});

	it("readCardBgDataUrl returns '' for empty/invalid/missing, data URL for valid", async () => {
		expect(await readCardBgDataUrl(dir, "")).toBe("");
		expect(await readCardBgDataUrl(dir, "../oops")).toBe("");
		expect(await readCardBgDataUrl(dir, `${"f".repeat(32)}.png`)).toBe(""); // valid id, missing file
		const id = await saveCardBg(dir, PNG, "image/png");
		expect(await readCardBgDataUrl(dir, id)).toMatch(/^data:image\/png;base64,/);
	});
});
