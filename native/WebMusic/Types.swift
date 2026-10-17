import Foundation

struct WebCredentials: Codable, CustomStringConvertible {
    let bearer: String
    let user: String
    var description: String { "WebCredentials<redacted>" }
    static func parse(bearer: String, user: String) throws -> WebCredentials {
        func normalize(_ raw: String) throws -> String {
            guard raw.utf8.count <= 16_384, !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw WebMusicError.invalidInput }
            let value = raw.trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty, value.unicodeScalars.allSatisfy({ (33...126).contains($0.value) }) else { throw WebMusicError.invalidInput }
            return value
        }
        guard bearer.utf8.count <= 16_384, !bearer.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw WebMusicError.invalidInput }
        var token = bearer.trimmingCharacters(in: .whitespaces)
        guard token.lowercased() != "bearer" else { throw WebMusicError.invalidInput }
        if token.lowercased().hasPrefix("bearer ") { token = String(token.dropFirst(7)) }
        return try WebCredentials(bearer: normalize(token), user: normalize(user))
    }
}

struct WebCredentialRecord: Codable {
    let credentials: WebCredentials
    let generation: String
}

struct WebMusicRequest: Decodable {
    let action: String
    var generation: String? = nil
    var catalogIds: [String]? = nil
    var position: Int? = nil
    var reconcileOnly: Bool? = nil
    var playlistId: String? = nil
    var name: String? = nil
    var credentials: WebCredentials? = nil
    var jobId: String? = nil
    var coverMode: ArtworkMode? = nil
    var country: String? = nil
    var term: String? = nil
    var artistId: String? = nil
    var releaseId: String? = nil
    var offset: Int? = nil

    static func decode(_ input: Data) throws -> WebMusicRequest {
        let catalogKeys: Set<String> = ["country", "term", "artistId", "releaseId", "offset"]
        let catalogActions: Set<String> = ["catalogArtists", "catalogReleases", "catalogTracks"]
        let allowedKeys: Set<String> = ["action", "generation", "catalogIds", "position", "reconcileOnly", "playlistId", "name", "credentials", "jobId", "coverMode", "country", "term", "artistId", "releaseId", "offset"]
        guard !input.isEmpty, input.count <= 128 * 1024,
              let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              Set(object.keys).isSubset(of: allowedKeys), let action = object["action"] as? String,
              action != "authorizeConnection" || Set(object.keys) == ["action"],
              object["jobId"] == nil || ["ensurePlaylist", "playlistCover"].contains(action),
              object["coverMode"] == nil || action == "playlistCover",
              action != "playlistCover" || (object["position"] == nil && object["reconcileOnly"] == nil) else { throw WebMusicError.invalidInput }
        if catalogActions.contains(action) {
            let fields: Set<String> = action == "catalogArtists" ? ["term"] : action == "catalogReleases" ? ["artistId", "offset"] : ["releaseId", "offset"]
            guard Set(object.keys).isSubset(of: fields.union(["action", "generation", "country"])),
                  !object.values.contains(where: { $0 is NSNull }) else { throw WebMusicError.invalidInput }
        } else if !Set(object.keys).isDisjoint(with: catalogKeys) { throw WebMusicError.invalidInput }
        if let credentials = object["credentials"] as? [String: Any] {
            guard Set(credentials.keys).isSubset(of: ["bearer", "user"]) else { throw WebMusicError.invalidInput }
        }
        guard let request = try? JSONDecoder().decode(WebMusicRequest.self, from: input) else { throw WebMusicError.invalidInput }
        return request
    }
}

struct WebMusicError: Error, Equatable, LocalizedError {
    let code: String
    let message: String
    var uncertain: Bool = false
    static let unavailable = WebMusicError(code: "unavailable", message: "The Apple Music connection is unavailable.")
    static let invalidInput = WebMusicError(code: "invalid-input", message: "The connection values or operation details are invalid.")
    static let generationChanged = WebMusicError(code: "generation-changed", message: "The saved Apple Music connection changed. Check the connection again.")
    static let storefrontMismatch = WebMusicError(code: "storefront-mismatch", message: "The saved Apple Music account storefront does not match the selected country.")
    static let catalogDate = WebMusicError(code: "catalog-date", message: "A release has no valid full Apple release date. Its chronological order cannot be verified.")
    static let busy = WebMusicError(code: "busy", message: "An Apple Music operation is in progress. Try again when it finishes.")
    static let missing = WebMusicError(code: "missing", message: "The Apple Music connection or requested resource is missing.")
    static let storage = WebMusicError(code: "storage", message: "Wavelength could not access its saved Apple Music connection. Use Check connection to allow Keychain access.")
    static let rejected = WebMusicError(code: "rejected", message: "Apple rejected the connection. Reconnect to Apple Music.")
    static let malformed = WebMusicError(code: "malformed", message: "Apple returned an unexpected response.")
    static let transport = WebMusicError(code: "transport", message: "The Apple Music request did not complete.")
    var errorDescription: String? { message }
    func withUncertainty(_ value: Bool) -> WebMusicError { WebMusicError(code: code, message: message, uncertain: value) }
    var envelope: [String: Any] { ["ok": false, "error": ["code": code, "message": message, "uncertain": uncertain]] }
}

protocol WebCredentialStorage {
    func read() throws -> Data?
    func save(_ data: Data) throws
    func delete() throws
}
protocol WebOperationLock {
    func acquire() throws
    func release()
}
protocol WebTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}
