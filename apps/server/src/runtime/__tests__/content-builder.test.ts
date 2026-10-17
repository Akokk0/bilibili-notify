/**
 * 单元测试 — `segmentContentBuilder` + `segmentToPayload`(独立端直播 payload 段构造)。
 *
 * 守护契约:
 *   - builder factory:text / image(只收字节 + mime) / atAll / message(过滤 null)
 *   - segmentToPayload:null→[];string 空→[],非空→[text];text 空→[],非空→[text];
 *     image-buf→[image];atAll→[text "@全体成员 "];
 *     message→递归 flatMap 展平嵌套
 */

import type { PayloadSegment } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { type SegmentValue, segmentContentBuilder, segmentToPayload } from "../content-builder.js";

const B = segmentContentBuilder;

describe("segmentContentBuilder — factory", () => {
	it("text / atAll", () => {
		expect(B.text("hi")).toEqual({ kind: "text", text: "hi" });
		expect(B.atAll()).toEqual({ kind: "atAll" });
	});

	it("image:只收字节,连同 mime 一起装成 image-buf", () => {
		const buf = Buffer.from("X");
		expect(B.image(buf, "image/png")).toEqual({
			kind: "image-buf",
			buffer: buf,
			mime: "image/png",
		});
	});

	it("message:过滤 null/undefined 段", () => {
		const seg = B.message([B.text("a"), null, undefined, B.atAll()]);
		expect(seg).toEqual({
			kind: "message",
			segments: [{ kind: "text", text: "a" }, { kind: "atAll" }],
		});
	});
});

describe("segmentToPayload — 解码", () => {
	it("null / undefined → []", () => {
		expect(segmentToPayload(null)).toEqual([]);
		expect(segmentToPayload(undefined)).toEqual([]);
	});

	it("string:空 → [],非空 → [text]", () => {
		expect(segmentToPayload("")).toEqual([]);
		expect(segmentToPayload("hello")).toEqual([{ kind: "text", text: "hello" }]);
	});

	it("text 段:空文本丢弃,非空保留", () => {
		expect(segmentToPayload({ kind: "text", text: "" })).toEqual([]);
		expect(segmentToPayload({ kind: "text", text: "x" })).toEqual([{ kind: "text", text: "x" }]);
	});

	it("image-buf → image;atAll → @全体成员 文本", () => {
		const buf = Buffer.from("Z");
		expect(segmentToPayload({ kind: "image-buf", buffer: buf, mime: "image/png" })).toEqual([
			{ kind: "image", buffer: buf, mime: "image/png" },
		]);
		expect(segmentToPayload({ kind: "atAll" })).toEqual([{ kind: "text", text: "@全体成员 " }]);
	});

	it("message:递归 flatMap 展平嵌套,空文本沿途丢弃", () => {
		const tree: SegmentValue = {
			kind: "message",
			segments: [
				{ kind: "text", text: "a" },
				{ kind: "text", text: "" }, // 丢弃
				{
					kind: "message",
					segments: [
						{ kind: "image-buf", buffer: Buffer.from("I"), mime: "image/png" },
						{ kind: "atAll" },
					],
				},
			],
		};
		const out: PayloadSegment[] = segmentToPayload(tree);
		expect(out).toEqual([
			{ kind: "text", text: "a" },
			{ kind: "image", buffer: Buffer.from("I"), mime: "image/png" },
			{ kind: "text", text: "@全体成员 " },
		]);
	});
});
