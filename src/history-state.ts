import { libraryEnvelope, parseAppleCSV } from "./history";
import { HISTORY_LIMITS, type HistoryPreview, type LibraryReadResult, type LibraryTrack, type ParsedExport } from "./history-types";
import { Store } from "./store";
import { summarizeHistory } from "./history-summary";

const selectAgain = "Select the file again to preview and import history.";
const superseded = "This history operation was superseded or forgotten. Select the file again.";

export class HistoryState {
  private generation = 0;
  private previewRevision = 0;
  private disposed = false;
  private pending: { token: string; expiresAt: number; generation: number; parsed: ParsedExport } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private store: Store, private now: () => number = Date.now) {}

  beginScan(): number {
    this.assertOpen();
    return this.generation;
  }

  finishScan(generation: number, result: LibraryReadResult): void {
    if (this.disposed || generation !== this.generation) throw new Error(superseded);
    const candidate = libraryEnvelope(result, new Date(this.now()).toISOString());
    summarizeHistory([candidate], {offset: 0, limit: HISTORY_LIMITS.pageSize, timeZone: "UTC"}, this.now());
    this.store.replaceHistory(candidate);
  }

  async preview(chunks: AsyncIterable<Uint8Array>): Promise<HistoryPreview> {
    this.assertOpen();
    const generation = this.generation;
    const revision = ++this.previewRevision;
    this.clearPreview();
    const parsed = await parseAppleCSV(chunks, this.savedLibraryRecords());
    if (this.disposed || generation !== this.generation || revision !== this.previewRevision) throw new Error(superseded);
    const replacesExport = this.store.history().some(item => item.source === "export");
    const token = crypto.randomUUID();
    const expiresAt = this.now() + HISTORY_LIMITS.previewMs;
    this.pending = { token, expiresAt, generation, parsed };
    this.timer = setTimeout(() => {
      if (this.pending?.token === token && this.previewRevision === revision) this.clearPreview();
    }, HISTORY_LIMITS.previewMs);
    this.timer.unref?.();
    return { token, expiresAt: new Date(expiresAt).toISOString(), profile: parsed.profile,
      coverage: structuredClone(parsed.coverage), replacesExport };
  }

  importPreview(token: string, replace: boolean): void {
    const pending = this.pending;
    if (this.disposed || !pending || token !== pending.token || pending.generation !== this.generation) throw new Error(selectAgain);
    if (this.now() >= pending.expiresAt) { this.clearPreview(); throw new Error(selectAgain); }
    if (!replace && this.store.history().some(item => item.source === "export")) throw new Error("Confirm replacement of the saved Apple export.");
    const candidate = { schemaVersion: 1 as const, source: "export" as const, importedAt: new Date(this.now()).toISOString(), ...pending.parsed };
    summarizeHistory([candidate], {offset: 0, limit: HISTORY_LIMITS.pageSize, timeZone: "UTC"}, this.now());
    this.store.replaceHistory(candidate);
    this.clearPreview();
  }

  forget(): void {
    this.assertOpen();
    this.generation++;
    this.previewRevision++;
    this.clearPreview();
    this.store.forgetHistory();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.previewRevision++;
    this.clearPreview();
  }

  private savedLibraryRecords(): LibraryTrack[] {
    const library = this.store.history().find(item => item.source === "library");
    return library?.records ?? [];
  }

  private clearPreview(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error(superseded);
  }
}
