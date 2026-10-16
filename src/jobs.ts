import type {CoverContext, DraftTrack, MusicJob, PlaylistCover, TrackWriteOutcome, WriterContext} from "./types";
import {Store} from "./store";

export type LegacyMusicAdapter = {
  kind?: undefined;
  ensurePlaylist(name: string, id?: string): Promise<{id: string; name: string}>;
  addTrackToPlaylist(track: DraftTrack, id: string): Promise<{libraryId: string; alreadyPresent: boolean}>;
  openPlaylist(id: string): Promise<void>;
};
export type WebMusicAdapter = {
  kind: "web-session";
  ensurePlaylist(name: string, id: string | undefined, context: {connectionGeneration: string; expectedCatalogIds: string[]; jobId?: string}): Promise<{id: string; name: string}>;
  addTrackToPlaylist(track: DraftTrack, id: string, context: WriterContext): Promise<TrackWriteOutcome>;
  getMusicStatus(): Promise<{generation?: string}>;
  rebindPlaylist(id: string, context: WriterContext): Promise<{generation: string}>;
  playlistCover(id: string, context: CoverContext): Promise<PlaylistCover>;
  openPlaylist(id: string): Promise<void>;
};
export type MusicAdapter = LegacyMusicAdapter | WebMusicAdapter;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export class Jobs {
  private activeId?: string;
  private cancelled = new Set<string>();
  constructor(private store: Store, private music: MusicAdapter, private assess: (track: DraftTrack, includeAI: boolean) => DraftTrack = track => track) {
    const recover: MusicJob[] = [];
    for (const job of store.all<MusicJob>("job")) {
      if (job.state === "running" || job.state === "queued") {
        job.state = "interrupted";
        job.message = "The app stopped before finishing. Retry to verify and continue the same playlist.";
        if (job.writer === "web-session") {
          job.creationState = job.playlistId ? "known" : job.creationState === "in-flight" ? "unknown" : job.creationState;
          if (job.creationState === "unknown") job.message = "Playlist creation outcome is unknown. Inspect Apple Music before starting another job; this job cannot safely create again.";
        }
        for (const item of job.tracks) if (item.state === "adding") {item.state = "failed"; item.error = "Addition was interrupted. Retry will check the playlist without repeating the write."; if (job.writer === "web-session") item.outcome = "uncertain";}
        this.save(job);
      }
      if (this.coverAllowed(job) && ["pending", "applying"].includes(job.cover?.state || "")) {
        if (job.cover?.state === "applying") {job.cover.state = "uncertain"; this.save(job);}
        recover.push(job);
      }
    }
    if (recover.length && music.kind === "web-session") {
      this.activeId = recover[0]!.id;
      void (async () => {
        for (const job of recover) {this.activeId = job.id; await this.runCover(job, music, "check");}
      })().finally(() => {this.activeId = undefined;});
    }
  }
  get(id: string) {return this.store.get<MusicJob>("job", id);}
  isActive(): boolean {return this.activeId !== undefined;}
  latest() {return this.activeId ? this.get(this.activeId) : this.store.all<MusicJob>("job").reverse().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];}
  private save(job: MusicJob) {job.updatedAt = new Date().toISOString(); this.store.put("job", job.id, job);}
  private available() {if (this.activeId) throw new Error("A playlist job is already running. Wait or cancel it first.");}
  create(name: string, tracks: DraftTrack[], includeAI = false, generation?: string): MusicJob {
    this.available();
    if (!tracks.length) throw new Error("Select at least one song.");
    if (this.music.kind === "web-session" && !generation) throw new Error("Check the Apple Music connection for this selection first.");
    const now = new Date().toISOString();
    const job: MusicJob = {id: crypto.randomUUID(), name, includeAI, state: "queued", tracks: tracks.map(track => ({track, state: "pending"})), message: "Waiting to create playlist", createdAt: now, updatedAt: now};
    if (this.music.kind === "web-session") {job.writer = "web-session"; job.connectionGeneration = generation; job.creationState = "not-started"; job.coverEligible = true;}
    this.save(job);
    this.start(job);
    return this.get(job.id)!;
  }
  retry(id: string): MusicJob {
    this.available();
    const job = this.get(id);
    if (!job) throw new Error("Playlist job not found.");
    if (this.music.kind === "web-session" && job.writer !== "web-session") throw new Error("This legacy Music-app job is preserved, but its original retry method is unavailable. Build a new playlist with the Apple Music connection.");
    if (job.state === "complete") throw new Error("This playlist is already complete.");
    if (job.writer === "web-session" && job.creationState === "unknown") throw new Error("Playlist creation outcome is unknown. Inspect Apple Music first; retry cannot safely create another playlist.");
    for (const item of job.tracks) if (item.state !== "added") item.track = this.assess(item.track, job.includeAI === true);
    if (job.writer !== "web-session") for (const item of job.tracks) if (item.state !== "added") {item.state = "pending"; delete item.error;}
    job.state = "queued";
    job.message = "Retrying unfinished additions";
    this.save(job);
    this.start(job, true);
    return this.get(id)!;
  }
  cancel(id: string): MusicJob {
    const job = this.get(id);
    if (!job) throw new Error("Playlist job not found.");
    if (job.state === "running" || job.state === "queued") {
      this.cancelled.add(id);
      job.message = "Stopping after the current song. Completed additions will stay in Music.";
      this.save(job);
    }
    return this.get(id)!;
  }
  private coverAllowed(job: MusicJob): boolean {
    return this.music.kind === "web-session" && job.writer === "web-session" && job.coverEligible === true &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(job.id) &&
      job.creationState === "known" && job.state === "complete" && !!job.playlistId && !!job.connectionGeneration &&
      job.tracks.length > 0 && job.tracks.every(item => item.state === "added" && item.outcome === "confirmed");
  }
  coverAction(id: string, action: "retry" | "check" | "permission"): MusicJob {
    this.available();
    const job = this.get(id);
    if (!job || !this.coverAllowed(job) || this.music.kind !== "web-session") throw new Error("This playlist job is not eligible for cover actions.");
    const mode = action === "permission" ? "authorize" : action === "check" || job.cover?.state !== "blocked" || job.cover.writeAttempted !== false ? "check" : "apply";
    this.activeId = id;
    const music = this.music;
    void this.runCover(job, music, mode, true).finally(() => {this.activeId = undefined;});
    return this.get(id)!;
  }
  async open(id: string) {
    const job = this.get(id);
    if (!job?.playlistId) throw new Error("This job has no Music playlist yet.");
    if (this.music.kind === "web-session") throw new Error("Open this playlist from your Apple Music library. A verified cloud playlist link is not available.");
    if (this.activeId) throw new Error("Wait for Music additions to finish before opening the playlist.");
    await this.music.openPlaylist(job.playlistId);
  }
  private start(job: MusicJob, retry = false) {
    this.activeId = job.id;
    this.cancelled.delete(job.id);
    void (this.music.kind === "web-session" ? this.runWeb(job, this.music, retry) : this.run(job, this.music)).finally(() => {this.activeId = undefined; this.cancelled.delete(job.id);});
  }
  private async runWeb(job: MusicJob, music: WebMusicAdapter, retry: boolean) {
    const expectedCatalogIds = job.tracks.map(item => String(item.track.catalogId));
    try {
      const position = job.tracks.findIndex(item => item.state !== "added");
      job.state = "running";
      job.message = retry && job.playlistId && position < 0 ? "Verifying completed playlist" : "Preparing Apple Music playlist";
      this.save(job);
      if (retry) {
        const current = await music.getMusicStatus();
        if (!current.generation) throw new Error("Reconnect to Apple Music before retrying.");
        if (job.playlistId) {
          const rebound = await music.rebindPlaylist(job.playlistId, {connectionGeneration: current.generation, expectedCatalogIds, position: position < 0 ? expectedCatalogIds.length : position, reconcileOnly: true});
          job.connectionGeneration = rebound.generation;
        } else job.connectionGeneration = current.generation;
        this.save(job);
      }
      if (!job.connectionGeneration) throw new Error("Check the Apple Music connection before creating a playlist.");
      if (!job.playlistId) {
        if (job.creationState === "unknown" || job.creationState === "in-flight") throw new Error("Playlist creation outcome is unknown; a second create is blocked.");
        const seed = job.tracks[0]!;
        seed.track = this.assess(seed.track, job.includeAI === true);
        // Creation may write the first song even if its reply or later track reads are lost.
        seed.state = "adding";
        seed.outcome = "uncertain";
        job.creationState = "in-flight";
        this.save(job);
        try {
          const playlist = await music.ensurePlaylist(job.name, undefined, {connectionGeneration: job.connectionGeneration, expectedCatalogIds, ...(job.coverEligible ? {jobId: job.id} : {})});
          job.playlistId = playlist.id;
          job.creationState = "known";
          this.save(job);
        } catch (error) {
          job.creationState = (error as {uncertain?: boolean})?.uncertain === false ? "not-started" : "unknown";
          throw error;
        }
      }
      for (let position = 0; position < job.tracks.length; position++) {
        if (this.cancelled.has(job.id)) break;
        const item = job.tracks[position]!;
        if (item.state === "added") continue;
        const reconcileOnly = item.outcome === "uncertain" || item.outcome === "conflict";
        // Persist uncertainty before IPC so a crash can never turn an in-flight append into a new POST.
        item.state = "adding";
        item.outcome = "uncertain";
        job.message = `${reconcileOnly ? "Verifying" : "Adding"} ${item.track.title} by ${item.track.artist}`;
        this.save(job);
        let result: TrackWriteOutcome;
        try {
          item.track = this.assess(item.track, job.includeAI === true);
        } catch (error) {result = {kind: "not-added", message: errorMessage(error)};}
        try {
          result ??= await music.addTrackToPlaylist(item.track, job.playlistId, {connectionGeneration: job.connectionGeneration, expectedCatalogIds, position, reconcileOnly});
        } catch {result = {kind: "uncertain", message: "The operation did not return a confirmed result. Retry will only inspect this song."};}
        if (reconcileOnly && result.kind === "not-added") result = {kind: "uncertain", message: result.message};
        if (result.kind === "confirmed" && result.catalogId !== String(item.track.catalogId)) result = {kind: "conflict", message: "Apple Music returned a different catalog song. The queue has stopped."};
        item.outcome = result.kind;
        if (result.kind === "confirmed") {item.state = "added"; item.libraryId = result.libraryId; delete item.error;}
        else {item.state = "failed"; item.error = result.message;}
        this.save(job);
        if (result.kind !== "confirmed") break;
      }
      const added = job.tracks.filter(item => item.state === "added").length;
      job.state = this.cancelled.has(job.id) ? "cancelled" : added === job.tracks.length ? "complete" : added > 0 ? "partial" : "failed";
      job.message = `${added} of ${job.tracks.length} songs confirmed${job.state === "cancelled" ? ". Stopped at your request." : job.state === "complete" ? ". Playlist is ready." : ". Queue stopped. Retry verifies the saved playlist first."}`;
    } catch (error) {job.state = "failed"; job.message = job.creationState === "unknown" ? "Playlist creation outcome is unknown. Inspect Apple Music before starting another job; retry is blocked." : errorMessage(error);}
    if (job.state === "complete" && this.coverAllowed(job)) job.cover = {state: "pending", helperAttempted: false};
    this.save(job);
    if (job.cover?.state === "pending") await this.runCover(job, music, "apply");
  }
  private async runCover(job: MusicJob, music: WebMusicAdapter, mode: CoverContext["mode"], currentGeneration = false) {
    if (!this.coverAllowed(job)) return;
    const prior = job.cover;
    job.cover = {...prior, state: "applying", helperAttempted: true};
    this.save(job);
    try {
      const generation = currentGeneration ? (await music.getMusicStatus()).generation : job.connectionGeneration;
      if (!generation) throw new Error("Connection unavailable");
      const next = await music.playlistCover(job.playlistId!, {jobId: job.id, name: job.name, connectionGeneration: generation, expectedCatalogIds: job.tracks.map(item => String(item.track.catalogId)), mode});
      if (!next || !["verified", "blocked", "uncertain"].includes(next.state) || next.helperAttempted !== true) throw new Error("Unconfirmed cover result");
      const uncertain = prior?.state === "uncertain" || prior?.state === "applying" || prior?.writeAttempted === true || mode === "check";
      job.cover = {...next, ...(uncertain && next.state !== "verified" ? {state: "uncertain"} : {}), ...(prior?.writeAttempted === true ? {writeAttempted: true} : {})};
    } catch {
      job.cover = {...job.cover, state: "uncertain", code: "connection-unconfirmed", helperAttempted: true};
    }
    this.save(job);
  }
  private async run(job: MusicJob, music: LegacyMusicAdapter) {
    try {
      job.state = "running";
      job.message = "Preparing playlist in Music";
      this.save(job);
      const playlist = await music.ensurePlaylist(job.name, job.playlistId);
      job.playlistId = playlist.id;
      this.save(job);
      for (const item of job.tracks) {
        if (this.cancelled.has(job.id)) break;
        if (item.state === "added") continue;
        item.state = "adding";
        job.message = `Adding ${item.track.title} by ${item.track.artist}`;
        this.save(job);
        try {
          item.track = this.assess(item.track, job.includeAI === true);
          const result = await music.addTrackToPlaylist(item.track, playlist.id);
          item.libraryId = result.libraryId;
          item.state = "added";
          delete item.error;
        } catch (error) {item.state = "failed"; item.error = errorMessage(error);}
        this.save(job);
      }
      const added = job.tracks.filter(item => item.state === "added").length;
      job.state = this.cancelled.has(job.id) ? "cancelled" : added === job.tracks.length ? "complete" : added > 0 ? "partial" : "failed";
      job.message = `${added} of ${job.tracks.length} songs added${job.state === "cancelled" ? ". Stopped at your request." : job.state === "complete" ? ". Playlist is ready." : ". Review failed songs and retry."}`;
    } catch (error) {job.state = "failed"; job.message = errorMessage(error);}
    this.save(job);
  }
}
