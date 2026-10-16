import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as filesystem from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import type { HistoryEnvelope } from "../src/history-types";
import { exportEnvelope, libraryTrack, savedLibrary } from "./fixtures/history";

test("history replaces fixed source keys and keeps the other source", async () => {
  const store = new Store(":memory:");
  try {
    const exported = await exportEnvelope("Song Name,Event End Timestamp\nExport,");
    store.replaceHistory(savedLibrary([libraryTrack()]));
    store.replaceHistory(exported);
    store.replaceHistory(savedLibrary([libraryTrack({ title: "Updated" })]));
    expect(store.history().map(item => item.source)).toEqual(["library", "export"]);
    expect(store.history()[0]!.records[0]!.title).toBe("Updated");
    expect(store.history()[1]).toEqual(exported);
    const library = store.history()[0];
    store.replaceHistory(await exportEnvelope("Song Name,Event End Timestamp\nReplacement,\nReplacement,"));
    expect(store.history()[0]).toEqual(library);
    expect(store.history()[1]!.records.length).toBe(2);
    expect(store.all("history").length).toBe(2);
  } finally { store.close(); }
});

test("forget deletes only the two fixed history keys", () => {
  const store = new Store(":memory:");
  try {
    store.replaceHistory(savedLibrary([libraryTrack()]));
    for (const kind of ["draft", "job", "provenance"]) store.put(kind, "keep", { kind });
    store.put("history", "unrelated", { keep: true });
    store.forgetHistory();
    expect(store.history()).toEqual([]);
    for (const kind of ["draft", "job", "provenance"]) expect(store.get<{ kind: string }>(kind, "keep")).toEqual({ kind });
    expect(store.get<{ keep: boolean }>("history", "unrelated")).toEqual({ keep: true });
  } finally { store.close(); }
});

test("unsupported saved or replacement schemas are recoverable without deleting state", () => {
  const store = new Store(":memory:");
  try {
    const valid = savedLibrary([libraryTrack()]);
    store.replaceHistory(valid);
    for (const invalid of [{ ...valid, schemaVersion: 2 }, { ...valid, source: "other" }]) {
      expect(() => store.replaceHistory(invalid as HistoryEnvelope)).toThrow(/forget.*reimport/i);
      expect(store.history()).toEqual([valid]);
    }
    store.put("history", "library", { ...valid, schemaVersion: 2 });
    expect(() => store.history()).toThrow(/forget.*reimport/i);
    expect(store.get("history", "library")).toMatchObject({ schemaVersion: 2 });
    store.forgetHistory();
    expect(store.history()).toEqual([]);
  } finally { store.close(); }
});

test("database permissions cover only its own regular files", () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-store-"));
  const path = join(directory, "state.sqlite");
  const unrelated = join(directory, "keep.txt");
  writeFileSync(unrelated, "synthetic", { mode: 0o644 });
  const store = new Store(path);
  try {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o644);
    store.replaceHistory(savedLibrary([libraryTrack()]));
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(unrelated).mode & 0o777).toBe(0o644);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test.each(["", "-wal", "-shm"])("constructor rejects preexisting symlink %s before SQLite touches its target", suffix => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-symlink-"));
  const path = join(directory, "state.sqlite");
  const target = join(directory, "keep.txt");
  writeFileSync(target, "synthetic untouched", { mode: 0o644 });
  symlinkSync(target, `${path}${suffix}`);
  try {
    expect(() => new Store(path)).toThrow(/regular|symbolic|symlink/i);
    expect(readFileSync(target, "utf8")).toBe("synthetic untouched");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(lstatSync(`${path}${suffix}`).isSymbolicLink()).toBe(true);
    if (suffix) expect(existsSync(path)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("constructor rejects a nonregular exact sidecar", () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-directory-"));
  const path = join(directory, "state.sqlite");
  mkdirSync(`${path}-wal`);
  try { expect(() => new Store(path)).toThrow(/regular/i); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite replacement failure preserves the previous records and report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-rollback-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const connection = new Database(path);
  try {
    const old = await exportEnvelope("Song Name,Event End Timestamp\nOld,");
    store.replaceHistory(old);
    connection.exec("CREATE TRIGGER reject_history BEFORE INSERT ON state WHEN NEW.kind='history' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    expect(() => store.replaceHistory(savedLibrary([libraryTrack()]))).toThrow("synthetic write failure");
    expect(() => store.replaceHistory({ ...old, records: [], coverage: { ...old.coverage, acceptedRows: 0 } })).toThrow("synthetic write failure");
    expect(store.history()).toEqual([old]);
  } finally { connection.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite forget failure rolls back both history deletions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-forget-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const connection = new Database(path);
  try {
    store.replaceHistory(savedLibrary([libraryTrack()]));
    store.replaceHistory(await exportEnvelope("Song Name,Event End Timestamp\nOld,"));
    const old = store.history();
    connection.exec("CREATE TRIGGER reject_forget BEFORE DELETE ON state WHEN OLD.kind='history' AND OLD.id='export' BEGIN SELECT RAISE(ABORT, 'synthetic forget failure'); END");
    expect(() => store.forgetHistory()).toThrow("synthetic forget failure");
    expect(store.history()).toEqual(old);
  } finally { connection.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("permission failure after deleting rolls back both history keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wavelength-forget-permissions-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  const chmod = filesystem.chmodSync;
  let permissionSpy: ReturnType<typeof spyOn<typeof filesystem, "chmodSync">> | undefined;
  try {
    store.replaceHistory(savedLibrary([libraryTrack()]));
    store.replaceHistory(await exportEnvelope("Song Name,Event End Timestamp\nOld,"));
    const old = store.history();
    let databaseChecks = 0;
    permissionSpy = spyOn(filesystem, "chmodSync").mockImplementation((file, mode) => {
      if (file === path && ++databaseChecks === 2) throw new Error("synthetic permission failure after deletion");
      chmod(file, mode);
    });
    expect(() => store.forgetHistory()).toThrow("synthetic permission failure after deletion");
    permissionSpy.mockRestore();
    expect(store.history()).toEqual(old);
    store.forgetHistory();
    expect(store.history()).toEqual([]);
  } finally { permissionSpy?.mockRestore(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
