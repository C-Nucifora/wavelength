import {Database} from "bun:sqlite";
import {chmodSync, lstatSync, mkdirSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {homedir} from "node:os";
import type {HistoryEnvelope} from "./history-types";

export const dataDirectory = process.env.WAVELENGTH_DATA_DIR || join(homedir(), "Library/Application Support/Wavelength");

export class Store {
  private db: Database;
  private lease?: Database;
  private path: string;
  constructor(path = join(dataDirectory, "state.sqlite")) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), {recursive: true, mode: 0o700});
    this.restrictDatabaseFiles(true);
    if (this.path !== ":memory:") {
      const leasePath = `${this.path}.lock`;
      try {if (!lstatSync(leasePath).isFile()) throw new Error("Database lock must be a regular file.");}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
      const lease = new Database(leasePath, {create: true});
      try {
        chmodSync(leasePath, 0o600);
        // Process exit releases this separate lock without blocking state writes.
        lease.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        this.lease = lease;
      } catch {lease.close(); throw new Error("Wavelength is already using this data directory. Quit the other instance and retry.");}
    }
    try {
      this.db = new Database(this.path, {create: true});
    } catch (error) {this.lease?.close(); throw error;}
    try {
      this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind, id))");
      this.restrictDatabaseFiles();
    } catch (error) { this.db.close(); this.lease?.close(); throw error; }
  }
  put(kind: string, id: string, value: unknown) {
    this.db.query("INSERT INTO state VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET json=excluded.json").run(kind, id, JSON.stringify(value));
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.query("SELECT json FROM state WHERE kind=? AND id=?").get(kind, id) as {json: string} | null;
    return row ? JSON.parse(row.json) : undefined;
  }
  all<T>(kind: string): T[] {
    return (this.db.query("SELECT json FROM state WHERE kind=? ORDER BY rowid").all(kind) as {json: string}[]).map(row => JSON.parse(row.json));
  }
  history(): HistoryEnvelope[] {
    const envelopes: HistoryEnvelope[] = [];
    for (const source of ["library", "export"] as const) {
      const envelope = this.get<HistoryEnvelope>("history", source);
      if (envelope === undefined) continue;
      this.validateHistory(envelope);
      if (envelope.source !== source) throw new Error("Unsupported history schema. Forget and reimport history.");
      envelopes.push(envelope);
    }
    return envelopes;
  }
  replaceHistory(envelope: HistoryEnvelope): void {
    this.validateHistory(envelope);
    this.restrictDatabaseFiles();
    this.db.transaction(() => {
      this.put("history", envelope.source, envelope);
      this.restrictDatabaseFiles();
    })();
  }
  forgetHistory(): void {
    this.restrictDatabaseFiles();
    this.db.transaction(() => {
      this.db.exec("DELETE FROM state WHERE kind='history' AND id IN ('library','export')");
      this.restrictDatabaseFiles();
    })();
  }
  private validateHistory(envelope: HistoryEnvelope): void {
    if (!envelope || envelope.schemaVersion !== 1 || !["library", "export"].includes(envelope.source)) {
      throw new Error("Unsupported history schema. Forget and reimport history.");
    }
  }
  private restrictDatabaseFiles(allowMissingDatabase = false): void {
    if (this.path === ":memory:") return;
    const files: string[] = [];
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        if (!lstatSync(file).isFile()) throw new Error("History database paths must be regular files, not symbolic links.");
        files.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && (allowMissingDatabase || file !== this.path)) continue;
        throw error;
      }
    }
    for (const file of files) chmodSync(file, 0o600);
  }
  close() {this.db.close(); this.lease?.close();}
}
