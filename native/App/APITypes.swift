import Foundation

struct SeedRequest: Codable {
    var mode = "genre"
    var seed = ""
    var count = 30
    var selection = "mix"
    var perArtist = 1
    var includeAI = false
    var country = "AU"
    var artistId: Int?
}
struct CatalogArtist: Codable, Identifiable { var id: Int; var name: String; var url: String; var artworkUrl: String? }
struct CatalogArtistsResponse: Codable { var artists: [CatalogArtist]; var storefront: String }
struct Provenance: Codable { var kind: String; var evidence: [String]; var note: String? }
struct DraftTrack: Codable, Identifiable {
    var id: String
    var catalogId: Int
    var artistId: Int
    var title: String
    var artist: String
    var album: String
    var durationMs: Double
    var releaseDate: String
    var artworkUrl: String?
    var url: String
    var source: String
    var sourceUrl: String?
    var match: String
    var provenance: Provenance
    var selected: Bool
    var releaseId: Int?
    var discNumber: Int?
    var trackNumber: Int?
    var duration: String { let seconds = Int(durationMs / 1000); return String(format: "%d:%02d", seconds / 60, seconds % 60) }
}
struct Draft: Codable, Identifiable {
    var id: String
    var request: SeedRequest
    var status: String
    var title: String
    var tracks: [DraftTrack]
    var warnings: [String]
    var progress: ProgressInfo
    var error: String?
    var createdAt: String
}
struct ProgressInfo: Codable { var done: Int; var total: Int; var message: String }
struct TrackResult: Codable, Identifiable {
    var track: DraftTrack
    var state: String
    var libraryId: String?
    var error: String?
    var outcome: String?
    var id: String { track.id }
}
struct MusicJob: Codable, Identifiable {
    var id: String
    var name: String
    var includeAI: Bool?
    var playlistId: String?
    var writer: String?
    var connectionGeneration: String?
    var creationState: String?
    var coverEligible: Bool?
    var cover: PlaylistCover?
    var state: String
    var tracks: [TrackResult]
    var message: String
    var createdAt: String
    var updatedAt: String
    var songActive: Bool { ["queued", "running"].contains(state) }
    var coverActive: Bool { ["pending", "applying"].contains(cover?.state ?? "") }
    var active: Bool { songActive || coverActive }
    var coverAction: String? {
        guard coverEligible == true, writer == "web-session", creationState == "known", UUID(uuidString: id) != nil,
              state == "complete", tracks.allSatisfy({ $0.state == "added" }), let cover, ["blocked", "uncertain"].contains(cover.state) else { return nil }
        if cover.code == "automation-permission" { return "cover-permission" }
        return cover.state == "blocked" && cover.writeAttempted == false ? "cover-retry" : "cover-check"
    }
    var finishable: Bool { writer == "web-session" && creationState == "known" && playlistId != nil && !tracks.isEmpty && tracks.allSatisfy { $0.state == "added" && $0.outcome == "confirmed" } }
    var retryable: Bool { writer == "web-session" && creationState != "unknown" && ["partial", "cancelled", "failed", "interrupted"].contains(state) && (finishable || tracks.contains { $0.state != "added" }) }
    var addedCount: Int { tracks.filter { $0.state == "added" }.count }
}
struct MusicStatus: Codable {
    var platform: String; var running: Bool; var accessibility: Bool; var automation: String; var message: String
    var backend: String?; var connection: String?; var generation: String?; var storefront: String?
}
struct Preflight: Codable {
    var id: String; var newLibraryAdditions: Int; var existingLibrarySongs: Int; var total: Int
    var generation: String?; var storefront: String?; var availableCatalogTracks: Int?; var unavailableCatalogTracks: Int?
    var unavailableCatalogIds: [String]?
}
struct SessionResponse: Codable { var token: String }
struct ReadyResponse: Codable { var ready: Bool; var instance: String; var activeJob: MusicJob? }
struct StatusResponse: Codable { var music: MusicStatus; var activeJob: MusicJob?; var version: String }
struct Genre: Codable, Identifiable { var name: String; var slug: String; var id: String { slug } }
struct GenresResponse: Codable { var genres: [Genre] }
struct OKResponse: Codable { var ok: Bool }
struct ErrorResponse: Codable { var error: String }
struct AppError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}
