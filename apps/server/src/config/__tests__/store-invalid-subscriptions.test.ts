import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmptySubscription, type ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { CONFIG_DIR, createConfigStore } from "../store.js";

let dataDir: string;
let file: string;
const sub = (externalId: string) =>
	makeEmptySubscription({ id: randomUUID(), identity: { sourceKey: "acme", externalId } });
const ctx = (): ServiceContext => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose: vi.fn(),
	signal: new AbortController().signal,
	track: vi.fn(),
});
const open = async (options: Partial<import("../store.js").CreateConfigStoreOptions> = {}) => {
	const store = createConfigStore({
		bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		serviceCtx: ctx(),
		...options,
	});
	await store.load();
	return store;
};
const put = async (subscriptions: unknown[]) =>
	writeFile(file, JSON.stringify({ tags: [], subscriptions }));
const disk = async () => JSON.parse(await readFile(file, "utf8"));
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-4-22-test-"));
	await mkdir(join(dataDir, ...CONFIG_DIR), { recursive: true });
	file = join(dataDir, ...CONFIG_DIR, "subscriptions.json");
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

it("characterization: reading valid unknown-source subscriptions does not rewrite the file", async () => {
	const a = sub("a");
	await put([a]);
	const bytes = await readFile(file, "utf8");
	expect((await open()).getSubscriptions()).toEqual([a]);
	expect(await readFile(file, "utf8")).toBe(bytes);
});
it.each([
	"{",
	"null",
	"[]",
	'{"tags":[],"subscriptions":{}}',
	'{"tags":[{"id":"bad","name":""}],"subscriptions":[]}',
])("characterization: file-level corruption still blocks loading: %s", async (bytes) => {
	await writeFile(file, bytes);
	await expect(open()).rejects.toThrow();
	expect(await readFile(file, "utf8")).toBe(bytes);
});

it("isolates a bad row without rewriting it, and carries it through a normal write", async () => {
	const a = sub("a");
	const b = sub("b");
	const bad = { ...sub("broken"), enabled: "secret-canary", unknown: { token: "private-value" } };
	await put([a, bad, b]);
	const bytes = await readFile(file, "utf8");
	const store = await open();
	expect(store.getSubscriptions()).toEqual([a, b]);
	expect(await readFile(file, "utf8")).toBe(bytes);
	await store.patchSubscription(b.id, { enabled: false });
	expect((await disk()).subscriptions).toEqual([a, bad, { ...b, enabled: false }]);
});

it("reserves a valid identity from an invalid row without requiring a valid subscription id", async () => {
	const bad = { identity: { sourceKey: "acme", externalId: "occupied", extra: "private" } };
	await put([bad]);
	const store = await open();
	const bytes = await readFile(file, "utf8");
	await expect(store.upsertSubscription(sub("occupied"))).rejects.toMatchObject({
		code: "conflict",
	});
	expect(await readFile(file, "utf8")).toBe(bytes);
});

it("restore preview and commit reserve bad identities, with no preview side effects", async () => {
	const a = sub("a"),
		bad = { ...sub("occupied"), enabled: "private" };
	await put([a, bad]);
	const store = await open();
	const bytes = await readFile(file, "utf8");
	const meta = store.getSubscriptionsMeta();
	for (const dryRun of [true, false])
		await expect(
			store.replaceSections({ subscriptions: [sub("occupied")] }, { dryRun }),
		).rejects.toMatchObject({ code: "conflict" });
	const next = { ...a, enabled: false };
	await store.replaceSections({ subscriptions: [next] }, { dryRun: true });
	expect(await readFile(file, "utf8")).toBe(bytes);
	expect(store.getSubscriptionsMeta()).toEqual(meta);
	expect(store.getSubscriptions()).toEqual([a]);
	await store.replaceSections({ subscriptions: [next] });
	expect((await disk()).subscriptions).toEqual([next, bad]);
});

it("backup dry-run rejects a reserved identity before confirmation", async () => {
	const { createBackupService } = await import("../../backup/service.js");
	const { buildBackup } = await import("../../backup/envelope.js");
	const { fakeIntegrationSecrets } = await import(
		"../../__tests__/support/backup-integration-secrets.js"
	);
	await put([{ ...sub("occupied"), enabled: "private" }]);
	const store = await open();
	const service = createBackupService({
		configStore: store,
		integrationSecrets: fakeIntegrationSecrets(),
	});
	const envelope = buildBackup({
		kind: "sanitized",
		sections: { subscriptions: [sub("occupied")] },
		createdAt: new Date().toISOString(),
	});
	await expect(
		service.importBackup({ envelope, mode: "merge", dryRun: true }),
	).rejects.toMatchObject({ code: "conflict" });
});

it("runtime reports one safe problem for isolated rows", async () => {
	const { createAppRuntime } = await import("../../runtime/bootstrap.js");
	await put([{ ...sub("private-identity"), enabled: "private-token" }, null]);
	const runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
		{ dataRoot: dataDir },
		{ integrationSettings: [] },
	);
	try {
		await runtime.configStore.load();
		const problems = runtime.problems.list();
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatchObject({ reporter: "core", code: "subscriptions_invalid" });
		expect(problems[0]?.message).toContain("2");
		expect(JSON.stringify(problems)).not.toMatch(/private-identity|private-token/);
	} finally {
		await runtime.dispose();
	}
});

it("retains valid UUIDs from isolated rows for the cache sweep", async () => {
	const a = sub("a"),
		broken = { ...sub("broken"), enabled: "private" };
	await put([a, broken, { ...broken }, null]);
	const store = await open();
	expect(store.getSubscriptionIds()).toEqual([a.id, broken.id]);
});

it.each([
	null,
	["raw", { token: "private" }],
	42,
	"raw",
	{ uid: "123", kind: "bilibili" },
	{ identity: { sourceKey: "Bad!", externalId: "x" } },
	{ identity: { sourceKey: "acme", externalId: 123 } },
	{ identity: { sourceKey: "acme", externalId: "" } },
])("keeps unidentifiable JSON values without guessing a source: %j", async (raw) => {
	const a = sub("a");
	await put([raw, a]);
	const store = await open();
	expect(store.getSubscriptions()).toEqual([a]);
	await store.upsertSubscription(sub("123"));
	expect((await disk()).subscriptions[0]).toEqual(raw);
});

it("quarantines every row in a duplicate UUID group and reserves all their identities", async () => {
	const a = sub("a"),
		b = { ...sub("b"), id: a.id },
		good = sub("good");
	await put([a, good, b]);
	const store = await open();
	expect(store.getSubscriptions()).toEqual([good]);
	for (const candidate of [sub("a"), sub("b"), { ...sub("other"), id: a.id }])
		await expect(store.upsertSubscription(candidate)).rejects.toMatchObject({ code: "conflict" });
	await store.patchSubscription(good.id, { enabled: false });
	expect((await disk()).subscriptions).toEqual([a, { ...good, enabled: false }, b]);
});

it("allows editing and deleting an existing good row with an identity also reserved by a bad row", async () => {
	const a = sub("same"),
		bad = { ...sub("same"), enabled: "bad" };
	await put([a, bad]);
	const store = await open();
	await store.patchSubscription(a.id, { notes: "kept" });
	await store.replaceSections({ subscriptions: [{ ...a, enabled: false }] });
	await expect(
		store.replaceSections({ subscriptions: [{ ...a, identity: bad.identity, id: randomUUID() }] }),
	).rejects.toMatchObject({ code: "conflict" });
	expect(await store.deleteSubscription(a.id)).toBe(true);
	await expect(store.upsertSubscription(sub("same"))).rejects.toMatchObject({ code: "conflict" });
	expect((await disk()).subscriptions).toEqual([bad]);
});

it("cannot repurpose an existing good id for a reserved bad identity during restore", async () => {
	const a = sub("a"),
		bad = { ...sub("bad"), enabled: "bad" };
	await put([a, bad]);
	const store = await open();
	await expect(
		store.replaceSections({ subscriptions: [{ ...a, identity: bad.identity }] }),
	).rejects.toMatchObject({ code: "conflict" });
	await expect(store.upsertSubscription({ ...sub("new"), id: bad.id })).rejects.toMatchObject({
		code: "conflict",
	});
	expect(await store.deleteSubscription(bad.id)).toBe(false);
	await expect(store.patchSubscription(bad.id, { enabled: false })).rejects.toMatchObject({
		code: "not_found",
	});
});

it("keeps the layout across repeated reordering, deletion and appending", async () => {
	const a = sub("a"),
		b = sub("b"),
		c = sub("c"),
		x = { broken: "x" },
		y = ["y"];
	await put([a, x, b, y]);
	const store = await open();
	await store.replaceSections({ subscriptions: [b, a] });
	expect((await disk()).subscriptions).toEqual([b, x, a, y]);
	await store.deleteSubscription(b.id);
	expect((await disk()).subscriptions).toEqual([x, a, y]);
	await store.upsertSubscription(c);
	expect((await disk()).subscriptions).toEqual([x, a, y, c]);
	await store.patchSubscription(a.id, { enabled: false });
	expect((await disk()).subscriptions).toEqual([x, { ...a, enabled: false }, y, c]);
});

it("changes tags only on good rows and leaves bad tag and routing values intact", async () => {
	const tag = { id: randomUUID(), name: "kept" };
	const a = { ...sub("a"), tagIds: [tag.id] },
		bad = { ...sub("bad"), enabled: "bad", tagIds: [tag.id], routing: { post: ["raw-target"] } };
	await writeFile(file, JSON.stringify({ tags: [tag], subscriptions: [a, bad] }));
	const store = await open();
	await store.replaceSubscriptionTags([]);
	expect((await disk()).subscriptions).toEqual([{ ...a, tagIds: [] }, bad]);
	await store.replaceSections({ subscriptionTags: [tag] });
	expect((await disk()).subscriptions[1]).toEqual(bad);
});

it("a failed later restore write rolls back bytes, memory and layout before the next write", async () => {
	const { chmod } = await import("node:fs/promises");
	const a = sub("a"),
		bad = { broken: "raw" };
	await put([a, bad]);
	const store = await open();
	const bytes = await readFile(file, "utf8"),
		meta = store.getSubscriptionsMeta();
	const settings = join(dataDir, ...CONFIG_DIR, "settings");
	await chmod(settings, 0o500);
	try {
		await expect(
			store.replaceSections({
				subscriptions: [],
				globals: { ...store.getGlobals(), profileRefreshCron: "*/9 * * * *" },
			}),
		).rejects.toThrow();
	} finally {
		await chmod(settings, 0o700);
	}
	expect(await readFile(file, "utf8")).toBe(bytes);
	expect(store.getSubscriptions()).toEqual([a]);
	expect(store.getSubscriptionsMeta()).toEqual(meta);
	await store.patchSubscription(a.id, { enabled: false });
	expect((await disk()).subscriptions).toEqual([{ ...a, enabled: false }, bad]);
});

it.each(["merge", "overwrite"] as const)(
	"%s restore exports only good rows and retains local invalid rows",
	async (mode) => {
		const { createBackupService } = await import("../../backup/service.js");
		const { buildBackup } = await import("../../backup/envelope.js");
		const { openFullBackup } = await import("../../backup/assemble.js");
		const { fakeIntegrationSecrets } = await import(
			"../../__tests__/support/backup-integration-secrets.js"
		);
		const a = sub("a"),
			bad = { ...sub("bad"), enabled: "private-token" };
		await put([a, bad]);
		const store = await open();
		const service = createBackupService({
			configStore: store,
			integrationSecrets: fakeIntegrationSecrets(),
		});
		const sanitized = await service.exportBackup({ kind: "sanitized" });
		expect(sanitized.sections?.subscriptions).toEqual([a]);
		const full = await service.exportBackup({ kind: "full", pin: "123456" });
		expect(openFullBackup(full, "123456").sections.subscriptions).toEqual([a]);
		const c = sub("c"),
			envelope = buildBackup({
				kind: "sanitized",
				sections: { subscriptions: [c] },
				createdAt: new Date().toISOString(),
			});
		const bytes = await readFile(file, "utf8");
		await service.importBackup({ envelope, mode, dryRun: true });
		expect(await readFile(file, "utf8")).toBe(bytes);
		await service.importBackup({ envelope, mode });
		expect((await disk()).subscriptions).toEqual(mode === "merge" ? [a, bad, c] : [bad, c]);
	},
);

it("repairs or removes rows only after reloading the edited file", async () => {
	const a = sub("a"),
		bad = { ...a, enabled: "bad" };
	await put([bad]);
	const store = await open();
	expect(store.getSubscriptions()).toEqual([]);
	await put([a]);
	expect((await open()).getSubscriptions()).toEqual([a]);
	await put([]);
	const clean = await open();
	await clean.upsertSubscription(a);
	expect(clean.getSubscriptions()).toEqual([a]);
});

it("cache sweep retains isolated UUID profiles and image references but clears true orphans", async () => {
	const { createSubscriptionStateStore, pruneOrphanSubscriptionState } = await import(
		"../../runtime/subscription-state-store.js"
	);
	const a = sub("a"),
		bad = { ...sub("bad"), enabled: "bad" };
	await put([a, bad]);
	const store = await open();
	const cache = createSubscriptionStateStore({ dataRoot: dataDir, logger: ctx().logger });
	const avatar = `${"a".repeat(64)}.webp` as const;
	const profile = { name: "kept", avatar, refreshedAt: new Date().toISOString() };
	await cache.patch(bad.id, { cachedProfile: profile });
	await cache.patch("orphan", {
		cachedProfile: { name: "orphan", refreshedAt: profile.refreshedAt },
	});
	await pruneOrphanSubscriptionState(cache, store);
	expect(cache.get(bad.id)?.cachedProfile).toEqual(profile);
	expect(cache.get("orphan")).toBeUndefined();
	expect(await cache.listImageRefs()).toEqual([avatar]);
	await store.deleteSubscription(a.id);
	await pruneOrphanSubscriptionState(cache, store);
	expect(cache.get(bad.id)?.cachedProfile).toEqual(profile);
	await cache.close();
});

it("a notification failure cannot fail loading or a later successful write or leak exception text", async () => {
	const a = sub("a"),
		bad = { broken: "private-token" };
	await put([a, bad]);
	const serviceCtx = ctx();
	const store = await open({
		serviceCtx,
		onInvalidSubscriptionsChanged: () => {
			throw new Error("private-token");
		},
	});
	await store.patchSubscription(a.id, { enabled: false });
	expect((await disk()).subscriptions).toEqual([{ ...a, enabled: false }, bad]);
	expect(JSON.stringify(vi.mocked(serviceCtx.logger.warn).mock.calls)).not.toContain(
		"private-token",
	);
});

it("dry-run does not write any section or metadata, emit events, or notify observers", async () => {
	const a = sub("a"),
		bad = { broken: "private-token" };
	await put([a, bad]);
	const bus = createNodeMessageBus(),
		notify = vi.fn();
	const store = await open({ bus, onInvalidSubscriptionsChanged: notify });
	const changes = vi.fn();
	bus.on("config-changed", changes);
	notify.mockClear();
	const core = join(dataDir, ...CONFIG_DIR, "settings", "core.json"),
		original = await readFile(core, "utf8"),
		bytes = await readFile(file, "utf8"),
		meta = store.getSubscriptionsMeta();
	await store.replaceSections(
		{ subscriptions: [], globals: { ...store.getGlobals(), profileRefreshCron: "*/7 * * * *" } },
		{ dryRun: true },
	);
	expect(await readFile(core, "utf8")).toBe(original);
	expect(await readFile(file, "utf8")).toBe(bytes);
	expect(store.getSubscriptionsMeta()).toEqual(meta);
	expect(store.getSubscriptions()).toEqual([a]);
	expect(changes).not.toHaveBeenCalled();
	expect(notify).not.toHaveBeenCalled();
});

it("reserved identity errors remain fixed even when a good legacy row shares that identity", async () => {
	const a = sub("private-identity"),
		bad = { ...sub("private-identity"), enabled: "bad" };
	await put([a, bad]);
	const store = await open();
	const error = await store
		.upsertSubscription(sub("private-identity"))
		.catch((err: unknown) => err);
	expect(error).toMatchObject({ code: "conflict" });
	expect(String(error)).not.toContain("private-identity");
});

it.each([true, false])(
	"backup does not reveal a reserved identity in duplicate diagnostics (dryRun=%s)",
	async (dryRun) => {
		const { createBackupService } = await import("../../backup/service.js"),
			{ buildBackup } = await import("../../backup/envelope.js"),
			{ fakeIntegrationSecrets } = await import(
				"../../__tests__/support/backup-integration-secrets.js"
			);
		const a = sub("private-identity"),
			bad = { ...sub("private-identity"), enabled: "bad" };
		await put([a, bad]);
		const store = await open();
		const service = createBackupService({
			configStore: store,
			integrationSecrets: fakeIntegrationSecrets(),
		});
		const envelope = buildBackup({
			kind: "sanitized",
			sections: { subscriptions: [a, sub("private-identity")] },
			createdAt: new Date().toISOString(),
		});
		const error = await service
			.importBackup({ envelope, mode: "merge", dryRun })
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("private-identity");
	},
);
