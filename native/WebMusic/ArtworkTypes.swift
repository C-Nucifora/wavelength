import Foundation

enum ArtworkMode: String, Codable { case apply, check, authorize }

struct ArtworkTrack: Codable, Equatable {
    let title: String
    let artist: String
    let album: String
    let durationSeconds: Double
}

struct ArtworkTarget: Codable {
    let jobID: String
    let playlistID: String
    let name: String
    let tracks: [ArtworkTrack]
}

struct ArtworkResult: Codable {
    let state: String
    let code: String
    let writeAttempted: Bool // Durable setter intent, not proof of dispatch.
    let imageHash: String?
}

protocol ArtworkService {
    func handle(_ target: ArtworkTarget, mode: ArtworkMode) async -> ArtworkResult
}

enum ArtworkPaths {
    static func root() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Wavelength/playlist-covers", isDirectory: true)
    }
    static func directory(jobID: String, root: URL) throws -> URL {
        guard let uuid = UUID(uuidString: jobID) else { throw WebMusicError.invalidInput }
        return root.appendingPathComponent(uuid.uuidString, isDirectory: true)
    }
}
