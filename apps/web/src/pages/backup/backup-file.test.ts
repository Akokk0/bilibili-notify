import { describe, expect, it } from "vite-plus/test";
import { BACKUP_FORMAT, backupFilename, isValidPin, looksLikeBackup } from "./backup-file";

/**
 * 备份下载文件名 + 6 位 PIN 校验的纯逻辑。完整档用 .bnbackup(含加密机密),脱敏档用
 * .json(纯明文、可读可 diff);文件名带日期便于主人区分多份备份。
 */
describe("backupFilename", () => {
	it("names a full backup .bnbackup with the date", () => {
		expect(backupFilename("full", "2026-07-10T12:00:00.000Z")).toBe(
			"bilibili-notify-full-2026-07-10.bnbackup",
		);
	});

	it("names a sanitized backup .json with the date", () => {
		expect(backupFilename("sanitized", "2026-07-10T08:30:00.000Z")).toBe(
			"bilibili-notify-sanitized-2026-07-10.json",
		);
	});

	it("falls back to a stable stem when createdAt is not a date", () => {
		expect(backupFilename("full", "")).toBe("bilibili-notify-full-backup.bnbackup");
	});
});

describe("isValidPin", () => {
	it("accepts exactly six digits", () => {
		expect(isValidPin("123456")).toBe(true);
		expect(isValidPin("000000")).toBe(true);
	});

	it("rejects anything that is not six digits", () => {
		expect(isValidPin("1234")).toBe(false);
		expect(isValidPin("12345")).toBe(false);
		expect(isValidPin("1234567")).toBe(false);
		expect(isValidPin("12a456")).toBe(false);
		expect(isValidPin("")).toBe(false);
	});
});

describe("looksLikeBackup", () => {
	it("accepts a well-formed backup envelope", () => {
		expect(looksLikeBackup({ format: BACKUP_FORMAT, kind: "full", createdAt: "t" })).toBe(true);
		expect(looksLikeBackup({ format: BACKUP_FORMAT, kind: "sanitized" })).toBe(true);
	});

	it("rejects non-backup or malformed objects", () => {
		expect(looksLikeBackup({ hello: "world" })).toBe(false);
		expect(looksLikeBackup({ format: BACKUP_FORMAT, kind: "weird" })).toBe(false);
		expect(looksLikeBackup(null)).toBe(false);
		expect(looksLikeBackup("string")).toBe(false);
	});
});
