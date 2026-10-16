import { expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as filesystem from "node:fs";
import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryState } from "../src/history-state";
import { Store } from "../src/store";
import type { ExportEnvelope } from "../src/history-types";
import { csvChunks, exportEnvelope, libraryTrack, savedLibrary } from "./fixtures/history";

const csv = (title = "Song") => `Song Name,Event End Timestamp\n${title},`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("preview returns only a token and report and stamps import at confirmation", async () => {
  const store = new Store(":memory:");
  let now = 0;
  const state = new HistoryState(store, () => now);
  try {
    const preview = await state.preview(csvChunks(csv()));
    expect(Object.keys(preview).sort()).toEqual(["coverage", "expiresAt", "profile", "replacesExport", "token"]);
    expect(preview).toMatchObject({ expiresAt: "1970-01-01T00:10:00.000Z", profile: "play-activity", replacesExport: false,
      coverage: { acceptedRows: 1, missing: { artist: 1 } } });
    expect(store.history()).toEqual([]);
    preview.coverage.acceptedRows = 999;
    now = 1234;
    state.importPreview(preview.token, false);
    expect(store.history()[0]).toMatchObject({ importedAt: "1970-01-01T00:00:01.234Z", records: [{ title: "Song" }], coverage: { acceptedRows: 1 } });
    expect(() => state.importPreview(preview.token, true)).toThrow(/select.*file.*again/i);
  } finally { state.dispose(); store.close(); }
});

test("preview uses library metadata captured when parsing starts", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  const release = deferred<void>();
  async function* slow() { await release.promise; yield new TextEncoder().encode("Song Name,Event End Timestamp,Album Name\nSong,,Album"); }
  try {
    store.replaceHistory(savedLibrary([libraryTrack({ artist: "Before" })]));
    const pending = state.preview(slow());
    store.replaceHistory(savedLibrary([libraryTrack({ artist: "After" })]));
    release.resolve();
    const preview = await pending;
    state.importPreview(preview.token, false);
    expect((store.history()[1] as ExportEnvelope).records[0]!.artist).toBe("Before");
  } finally { state.dispose(); store.close(); }
});

test("older preview cannot replace a newer token", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  const release = deferred<void>();
  async function* slow() { await release.promise; yield new TextEncoder().encode(csv("Old")); }
  try {
    const old = state.preview(slow());
    const current = await state.preview(csvChunks(csv("New")));
    release.resolve();
    await expect(old).rejects.toThrow("superseded");
    state.importPreview(current.token, false);
    expect(store.history()[0]!.records[0]!.title).toBe("New");
  } finally { state.dispose(); store.close(); }
});

test("new preview immediately invalidates the previous token, even if parsing fails", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  const release = deferred<void>();
  async function* invalid() { await release.promise; yield new TextEncoder().encode("Title\nInvalid"); }
  try {
    const old = await state.preview(csvChunks(csv()));
    const pending = state.preview(invalid());
    expect(() => state.importPreview(old.token, false)).toThrow(/select.*file.*again/i);
    release.resolve();
    await expect(pending).rejects.toThrow("Unsupported");
    expect(() => state.importPreview(old.token, false)).toThrow(/select.*file.*again/i);
    expect(store.history()).toEqual([]);
  } finally { state.dispose(); store.close(); }
});

test.each([599999, 600000])("preview expiry checks the clock at %i ms", async elapsed => {
  const store = new Store(":memory:");
  let now = 0;
  const state = new HistoryState(store, () => now);
  try {
    const preview = await state.preview(csvChunks(csv()));
    now = elapsed;
    if (elapsed === 600000) {
      expect(() => state.importPreview(preview.token, false)).toThrow(/select.*file.*again/i);
      expect(store.history()).toEqual([]);
    } else {
      state.importPreview(preview.token, false);
      expect(store.history()[0]!.records.length).toBe(1);
    }
  } finally { state.dispose(); store.close(); }
});

test("expiry timer releases a preview even when the injected clock has not advanced", async () => {
  jest.useFakeTimers();
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    const preview = await state.preview(csvChunks(csv()));
    jest.advanceTimersByTime(600000);
    expect(() => state.importPreview(preview.token, false)).toThrow(/select.*file.*again/i);
    expect(store.history()).toEqual([]);
  } finally { state.dispose(); store.close(); jest.useRealTimers(); }
});

test("the previous preview's deadline cannot clear a newer preview", async () => {
  jest.useFakeTimers();
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    await state.preview(csvChunks(csv("Old")));
    jest.advanceTimersByTime(300000);
    const current = await state.preview(csvChunks(csv("New")));
    jest.advanceTimersByTime(300000);
    state.importPreview(current.token, false);
    expect(store.history()[0]!.records[0]!.title).toBe("New");
  } finally { state.dispose(); store.close(); jest.useRealTimers(); }
});

test("replacement requires confirmation and repeated imports replace rather than append", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    store.replaceHistory(savedLibrary([libraryTrack()]));
    const library = store.history()[0];
    const first = await state.preview(csvChunks(csv()));
    state.importPreview(first.token, false);
    const second = await state.preview(csvChunks(csv()));
    expect(second.replacesExport).toBe(true);
    expect(() => state.importPreview(second.token, false)).toThrow(/replace|confirm/i);
    state.importPreview(second.token, true);
    expect(store.history()[0]).toEqual(library);
    expect(store.history()[1]!.records.length).toBe(1);
  } finally { state.dispose(); store.close(); }
});

test("new state cannot import another instance's preview", async () => {
  const store = new Store(":memory:");
  const first = new HistoryState(store, () => 0);
  const second = new HistoryState(store, () => 0);
  try {
    const preview = await first.preview(csvChunks(csv()));
    for (const token of ["", "unknown", preview.token]) expect(() => second.importPreview(token, false)).toThrow(/select.*file.*again/i);
    expect(store.history()).toEqual([]);
  } finally { first.dispose(); second.dispose(); store.close(); }
});

test("forget invalidates pending scan and preserves unrelated state", () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    for (const kind of ["draft", "job", "provenance"]) store.put(kind, kind, { id: kind });
    const generation = state.beginScan();
    state.forget();
    expect(() => state.finishScan(generation, { complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: [] })).toThrow("forgotten");
    expect(store.history()).toEqual([]);
    for (const kind of ["draft", "job", "provenance"]) expect(store.get<{ id: string }>(kind, kind)).toEqual({ id: kind });
    state.finishScan(state.beginScan(), { complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: [] });
    expect(store.history()[0]).toMatchObject({ capturedAt: "1970-01-01T00:00:00.000Z" });
  } finally { state.dispose(); store.close(); }
});

test.each(["forget", "dispose"] as const)("%s prevents a pending CSV parse from publishing", async operation => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  const release = deferred<void>();
  async function* slow() { await release.promise; yield new TextEncoder().encode(csv()); }
  try {
    const ready = await state.preview(csvChunks(csv()));
    const generation = state.beginScan();
    const pending = state.preview(slow());
    state[operation]();
    release.resolve();
    await expect(pending).rejects.toThrow(/superseded|forgotten/i);
    expect(() => state.importPreview(ready.token, false)).toThrow(/select.*file.*again/i);
    expect(() => state.finishScan(generation, { complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: [] })).toThrow();
    expect(store.history()).toEqual([]);
    if (operation === "dispose") {
      expect(() => state.beginScan()).toThrow();
      await expect(state.preview(csvChunks(csv()))).rejects.toThrow();
      expect(() => state.forget()).toThrow();
    }
  } finally { state.dispose(); store.close(); }
});

test("parser failure preserves the saved export", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    const old = await exportEnvelope(csv("Old"));
    store.replaceHistory(old);
    await expect(state.preview(csvChunks("unsupported\nbody"))).rejects.toThrow();
    expect(store.history()).toEqual([old]);
  } finally { state.dispose(); store.close(); }
});

test("aggregate scan overflow preserves the prior library report", () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    const old = savedLibrary([libraryTrack()]);
    store.replaceHistory(old);
    expect(() => state.finishScan(state.beginScan(), {complete: true, declaredTrackCount: 2, warnings: [], tracks: [
      libraryTrack({playedCount: 1e308}), libraryTrack({id: "0000000000000002", playedCount: 1e308}),
    ]})).toThrow("overflow");
    expect(store.history()).toEqual([old]);
  } finally {state.dispose(); store.close();}
});

test("aggregate import overflow preserves the prior report and preview token", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  try {
    const old = await exportEnvelope(csv("Old"));
    store.replaceHistory(old);
    const huge = `Song Name,Event End Timestamp,Play Duration Milliseconds\nNew,,${"1" + "0".repeat(308)}\nOther,,${"1" + "0".repeat(308)}`;
    const preview = await state.preview(csvChunks(huge));
    expect(() => state.importPreview(preview.token, true)).toThrow("overflow");
    expect(store.history()).toEqual([old]);
    expect(() => state.importPreview(preview.token, false)).toThrow("Confirm replacement");
    expect(() => state.importPreview(preview.token, true)).toThrow("overflow");
  } finally {state.dispose(); store.close();}
});

test("preview failure while reading saved state never leaves an importable token", async () => {
  const store = new Store(":memory:");
  const state = new HistoryState(store, () => 0);
  const release = deferred<void>();
  const token = "00000000-0000-0000-0000-000000000001";
  const tokenSpy = spyOn(crypto, "randomUUID").mockReturnValue(token);
  async function* slow() { await release.promise; yield new TextEncoder().encode(csv()); }
  try {
    const pending = state.preview(slow());
    store.put("history", "export", { schemaVersion: 2, source: "export" });
    release.resolve();
    await expect(pending).rejects.toThrow(/forget.*reimport/i);
    expect(() => state.importPreview(token, true)).toThrow(/select.*file.*again/i);
    expect(store.get<{ schemaVersion: number; source: string }>("history", "export")).toEqual({ schemaVersion: 2, source: "export" });
  } finally { tokenSpy.mockRestore(); state.dispose(); store.close(); }
});

test("failed import keeps the previous envelope and current token available for retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-preview-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const connection = new Database(path);
  const state = new HistoryState(store, () => 0);
  try {
    const old = await exportEnvelope(csv("Old"));
    store.replaceHistory(old);
    const preview = await state.preview(csvChunks(csv("New")));
    connection.exec("CREATE TRIGGER reject_history BEFORE INSERT ON state WHEN NEW.kind='history' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    expect(() => state.importPreview(preview.token, true)).toThrow("synthetic write failure");
    expect(store.history()).toEqual([old]);
    connection.exec("DROP TRIGGER reject_history");
    state.importPreview(preview.token, true);
    expect(store.history()[0]!.records[0]!.title).toBe("New");
  } finally { state.dispose(); connection.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("permission failure after writing rolls back import and retains the token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-permission-rollback-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const state = new HistoryState(store, () => 0);
  const chmod = filesystem.chmodSync;
  let permissionSpy: ReturnType<typeof spyOn<typeof filesystem, "chmodSync">> | undefined;
  try {
    const old = await exportEnvelope(csv("Old"));
    store.replaceHistory(old);
    const preview = await state.preview(csvChunks(csv("New")));
    let databaseChecks = 0;
    permissionSpy = spyOn(filesystem, "chmodSync").mockImplementation((file, mode) => {
      if (file === path && ++databaseChecks === 2) throw new Error("synthetic permission failure after write");
      chmod(file, mode);
    });
    expect(() => state.importPreview(preview.token, true)).toThrow("synthetic permission failure after write");
    permissionSpy.mockRestore();
    expect(store.history()).toEqual([old]);
    state.importPreview(preview.token, true);
    expect(store.history()[0]).toMatchObject({ records: [{ title: "New" }], coverage: { acceptedRows: 1 } });
  } finally { permissionSpy?.mockRestore(); state.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("failed forget still invalidates existing previews and pending scans", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-forget-generation-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const connection = new Database(path);
  const state = new HistoryState(store, () => 0);
  try {
    const old = await exportEnvelope(csv("Old"));
    store.replaceHistory(old);
    const preview = await state.preview(csvChunks(csv("New")));
    const generation = state.beginScan();
    connection.exec("CREATE TRIGGER reject_forget BEFORE DELETE ON state WHEN OLD.kind='history' BEGIN SELECT RAISE(ABORT, 'synthetic forget failure'); END");
    expect(() => state.forget()).toThrow("synthetic forget failure");
    expect(store.history()).toEqual([old]);
    expect(() => state.importPreview(preview.token, true)).toThrow(/select.*file.*again/i);
    expect(() => state.finishScan(generation, { complete: true, declaredTrackCount: 1, tracks: [libraryTrack()], warnings: [] })).toThrow("forgotten");
    connection.exec("DROP TRIGGER reject_forget");
    state.forget();
    expect(store.history()).toEqual([]);
  } finally { state.dispose(); connection.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("sidecar symlink refusal preserves saved history and a retryable preview", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-permissions-"));
  const path = join(directory, "state.sqlite");
  const target = join(directory, "keep.txt");
  const store = new Store(path);
  const state = new HistoryState(store, () => 0);
  const sidecar = `${path}-wal`;
  const backup = join(directory, "owned-sidecar");
  try {
    const old = await exportEnvelope(csv("Old"));
    store.replaceHistory(old);
    const preview = await state.preview(csvChunks(csv("New")));
    writeFileSync(target, "synthetic", { mode: 0o644 });
    renameSync(sidecar, backup);
    symlinkSync(target, sidecar);
    try {
      expect(() => state.importPreview(preview.token, true)).toThrow(/regular|symbolic|symlink/i);
      expect(() => store.forgetHistory()).toThrow(/regular|symbolic|symlink/i);
      expect(statSync(target).mode & 0o777).toBe(0o644);
    } finally { rmSync(sidecar); renameSync(backup, sidecar); }
    expect(store.history()).toEqual([old]);
    expect(() => state.importPreview(preview.token, false)).toThrow("Confirm replacement");
  } finally { state.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
