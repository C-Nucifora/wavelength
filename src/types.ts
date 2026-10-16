export type SeedRequest = {
  mode: "genre" | "artist" | "discography";
  seed: string;
  artistId?: number;
  count: number;
  selection: "mix" | "essentials" | "recent";
  perArtist: number;
  includeAI: boolean;
  country: string;
};

export type Provenance = {
  kind: "unknown" | "ai" | "human";
  evidence: string[];
  note?: string;
};

export type DraftTrack = {
  id: string;
  catalogId: number;
  artistId: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  releaseDate: string;
  artworkUrl?: string;
  url: string;
  source: string;
  sourceUrl?: string;
  match: "exact" | "review";
  provenance: Provenance;
  selected: boolean;
  releaseId?: number;
  discNumber?: number;
  trackNumber?: number;
};

export type CatalogArtist = {id: number; name: string; url: string; artworkUrl?: string};
export type ArtistSearchResult = {artists: CatalogArtist[]; storefront: string};

export type Draft = {
  id: string;
  request: SeedRequest;
  status: "building" | "ready" | "cancelled" | "failed";
  title: string;
  tracks: DraftTrack[];
  warnings: string[];
  progress: { done: number; total: number; message: string };
  error?: string;
  createdAt: string;
};

export type TrackResult = {
  track: DraftTrack;
  state: "pending" | "adding" | "added" | "failed";
  libraryId?: string;
  error?: string;
  outcome?: TrackWriteOutcome["kind"];
};

export type WriterContext = {connectionGeneration: string; expectedCatalogIds: string[]; position: number; reconcileOnly: boolean};
export type PlaylistCover = {
  state: "pending" | "applying" | "verified" | "blocked" | "uncertain";
  code?: string;
  helperAttempted: boolean;
  writeAttempted?: boolean;
  imageHash?: string;
};
export type CoverContext = {jobId: string; name: string; connectionGeneration: string; expectedCatalogIds: string[]; mode: "apply" | "check" | "authorize"};
export type TrackWriteOutcome =
  | {kind: "confirmed"; catalogId: string; alreadyPresent: boolean; libraryId?: string}
  | {kind: "not-added" | "uncertain" | "conflict"; message: string};

export type MusicJob = {
  id: string;
  name: string;
  includeAI?: boolean;
  playlistId?: string;
  writer?: "web-session";
  connectionGeneration?: string;
  creationState?: "not-started" | "in-flight" | "known" | "unknown";
  coverEligible?: boolean;
  cover?: PlaylistCover;
  state: "queued" | "running" | "complete" | "partial" | "cancelled" | "failed" | "interrupted";
  tracks: TrackResult[];
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type MusicStatus = {
  platform: string;
  running: boolean;
  accessibility: boolean;
  automation: "unknown" | "granted" | "denied";
  message: string;
  backend?: "web-session";
  connection?: "missing" | "saved";
  generation?: string;
  storefront?: string;
};
