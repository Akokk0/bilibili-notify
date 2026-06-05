import { describe, expect, it } from "vitest";
import { SidecarEventQueue } from "./event-queue.js";

describe("SidecarEventQueue", () => {
	it("keeps the newest events and filters by cursor", () => {
		const queue = new SidecarEventQueue({ maxSize: 2 });

		const first = queue.push({ type: "auth-lost" });
		const second = queue.push({ type: "auth-restored" });
		const third = queue.push({ type: "engine-error", source: "dynamic-engine", message: "boom" });

		expect(first.id).toBe(1);
		expect(second.id).toBe(2);
		expect(third.id).toBe(3);
		expect(queue.drain(0).map((event) => event.id)).toEqual([2, 3]);
		expect(queue.drain(2).map((event) => event.id)).toEqual([3]);
		expect(queue.snapshot()).toEqual({ nextId: 4, size: 2 });
	});
});
