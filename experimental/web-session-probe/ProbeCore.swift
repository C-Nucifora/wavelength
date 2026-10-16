import Foundation

enum ProbeError: Error, LocalizedError, Equatable {
    case invalidInput, storage, attemptStorage, rejected, rateLimited, missing, server, malformed, transport, unsafeURL
    var errorDescription: String? {
        switch self {
        case .invalidInput: return "Enter both header values, without line breaks. Maximum 16,384 bytes each."
        case .storage: return "The probe could not access its Keychain connection."
        case .attemptStorage: return "The probe could not save its local attempt record."
        case .rejected: return "Apple rejected the connection. The web session may have expired."
        case .rateLimited: return "Apple rate limited this request. Wait before checking again."
        case .missing: return "Apple could not find this resource."
        case .server: return "Apple returned an unsuccessful response."
        case .malformed: return "Apple's response did not match the expected contract."
        case .transport: return "The request did not complete. Its outcome may be unknown."
        case .unsafeURL: return "The probe blocked an unexpected URL or redirect."
        }
    }
}

struct Credentials: Codable, CustomStringConvertible {
    let bearer: String
    let user: String
    var description: String { "Credentials<redacted>" }
    static func parse(bearer: String, user: String) throws -> Credentials {
        func normalize(_ raw: String) throws -> String {
            guard raw.utf8.count <= 16_384, !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw ProbeError.invalidInput }
            let value = raw.trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty, value.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else { throw ProbeError.invalidInput }
            return value
        }
        guard !bearer.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw ProbeError.invalidInput }
        var token = bearer.trimmingCharacters(in: .whitespaces)
        guard token.lowercased() != "bearer" else { throw ProbeError.invalidInput }
        if token.lowercased().hasPrefix("bearer ") { token = String(token.dropFirst(7)) }
        guard bearer.utf8.count <= 16_384 else { throw ProbeError.invalidInput }
        return try Credentials(bearer: normalize(token), user: normalize(user))
    }
}

protocol CredentialStorage {
    func read() throws -> Data?
    func save(_ data: Data) throws
    func delete() throws
}

struct Connection {
    let storefront: String
    let songs: [TestSong]
}
struct TestSong: Equatable { let id: String; let title: String; let artist: String }
struct WriteOutcome { let playlistID: String?; let confirmed: Bool; let message: String }

final class ProbeClient: NSObject, URLSessionTaskDelegate {
    private let credentials: Credentials
    private let configuration: URLSessionConfiguration
    private let pollDelay: UInt64
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    init(credentials: Credentials, configuration: URLSessionConfiguration = .ephemeral, pollDelay: UInt64 = 1_000_000_000) {
        self.credentials = credentials; self.configuration = configuration; self.pollDelay = pollDelay
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 30
        super.init()
    }
    private func valid(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
    func request(path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        let allowed = path == "/v1/me/storefront" || path == "/v1/me/library/playlists" || valid(path, pattern: "^/v1/catalog/[a-z]{2}/search$") || valid(path, pattern: "^/v1/me/library/playlists/[A-Za-z0-9][A-Za-z0-9.-]{0,127}/tracks$")
        guard allowed, method == "GET" || method == "POST" else { throw ProbeError.unsafeURL }
        var request = URLRequest(url: URL(string: "https://amp-api.music.apple.com" + path)!)
        request.httpMethod = method; request.httpShouldHandleCookies = false
        request.setValue("Bearer " + credentials.bearer, forHTTPHeaderField: "Authorization")
        request.setValue(credentials.user, forHTTPHeaderField: "Media-User-Token")
        request.setValue("https://music.apple.com", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }
    private func send(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.url?.scheme == "https", http.url?.host == "amp-api.music.apple.com" else { throw ProbeError.unsafeURL }
            switch http.statusCode {
            case 200...299: break
            case 300...399: throw ProbeError.unsafeURL
            case 401, 403: throw ProbeError.rejected
            case 404: throw ProbeError.missing
            case 429: throw ProbeError.rateLimited
            default: throw ProbeError.server
            }
            guard data.count <= 2_000_000 else { throw ProbeError.malformed }
            return data
        } catch let error as ProbeError { throw error }
        catch { throw ProbeError.transport }
    }
    private func json(_ data: Data) throws -> [String: Any] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ProbeError.malformed }
        return object
    }
    func check() async throws -> Connection {
        defer { session.finishTasksAndInvalidate() }
        let object = try json(await send(request(path: "/v1/me/storefront")))
        guard let stores = object["data"] as? [[String: Any]], stores.count == 1, stores[0]["type"] as? String == "storefronts", let storefront = stores[0]["id"] as? String, valid(storefront, pattern: "^[a-z]{2}$") else { throw ProbeError.malformed }
        var songs: [TestSong] = []
        for title in ["No Surprises", "Karma Police"] {
            var request = try request(path: "/v1/catalog/\(storefront)/search")
            var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "term", value: "Radiohead " + title), URLQueryItem(name: "types", value: "songs"), URLQueryItem(name: "limit", value: "25")]
            request.url = url.url
            let response = try json(await send(request))
            guard let results = response["results"] as? [String: Any], let songResults = results["songs"] as? [String: Any], let data = songResults["data"] as? [[String: Any]] else { throw ProbeError.malformed }
            guard let match = data.first(where: { song in
                guard song["type"] as? String == "songs", let attrs = song["attributes"] as? [String: Any] else { return false }
                return (attrs["name"] as? String)?.caseInsensitiveCompare(title) == .orderedSame && (attrs["artistName"] as? String)?.caseInsensitiveCompare("Radiohead") == .orderedSame
            }), let id = match["id"] as? String, valid(id, pattern: "^[0-9]{1,20}$") else { throw ProbeError.malformed }
            songs.append(TestSong(id: id, title: title, artist: "Radiohead"))
        }
        return Connection(storefront: storefront, songs: songs)
    }
    func create(_ connection: Connection, knownID: @MainActor (String) throws -> Void) async -> WriteOutcome {
        defer { session.finishTasksAndInvalidate() }
        guard connection.songs.count == 2, connection.songs.allSatisfy({ valid($0.id, pattern: "^[0-9]{1,20}$") }), connection.songs[0].id != connection.songs[1].id else {
            return WriteOutcome(playlistID: nil, confirmed: false, message: ProbeError.invalidInput.localizedDescription)
        }
        func ref(_ song: TestSong) -> [String: String] { ["id": song.id, "type": "songs"] }
        let name = "Wavelength connection test " + ISO8601DateFormatter().string(from: Date()) + " " + UUID().uuidString.prefix(8)
        let body: [String: Any] = ["attributes": ["name": name, "description": "Experimental web-session connection test. Two Radiohead tracks."], "relationships": ["tracks": ["data": [ref(connection.songs[0])]]]]
        let id: String
        do {
            let response = try json(await send(request(path: "/v1/me/library/playlists", method: "POST", body: body)))
            guard let data = response["data"] as? [[String: Any]], data.count == 1, data[0]["type"] as? String == "library-playlists", let value = data[0]["id"] as? String, valid(value, pattern: "^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$") else { throw ProbeError.malformed }
            id = value
        } catch {
            let message = (error as? ProbeError ?? .transport).localizedDescription
            return WriteOutcome(playlistID: nil, confirmed: false, message: message + " A playlist may exist without a returned ID. Inspect Apple Music before any further test. No write was retried.")
        }
        do { try await knownID(id) }
        catch { return WriteOutcome(playlistID: id, confirmed: false, message: "Created playlist ID retained in this window, but local state could not be saved. Append was stopped. Record this ID and inspect Apple Music.") }
        var appendAcknowledged = true
        do { _ = try await send(request(path: "/v1/me/library/playlists/\(id)/tracks", method: "POST", body: ["data": [ref(connection.songs[1])]])) }
        catch { appendAcknowledged = false }
        for attempt in 0..<5 {
            do {
                var read = try request(path: "/v1/me/library/playlists/\(id)/tracks")
                var url = URLComponents(url: read.url!, resolvingAgainstBaseURL: false)!
                url.queryItems = [URLQueryItem(name: "limit", value: "100")]; read.url = url.url
                let object = try json(await send(read))
                if try catalogIDs(object) == connection.songs.map(\.id) {
                    return WriteOutcome(playlistID: id, confirmed: true, message: appendAcknowledged ? "Confirmed both catalog songs in the expected order." : "Confirmed both catalog songs in order by readback. The append response was uncertain; no write was retried.")
                }
            } catch {}
            if attempt < 4, pollDelay > 0 { try? await Task.sleep(nanoseconds: pollDelay) }
        }
        return WriteOutcome(playlistID: id, confirmed: false, message: "Playlist ID retained. Both songs could not be confirmed in order. The playlist may be partial or still updating. Inspect Apple Music. No write was retried.")
    }
    private func catalogIDs(_ object: [String: Any]) throws -> [String] {
        guard object["next"] == nil, let data = object["data"] as? [[String: Any]], data.count <= 100 else { throw ProbeError.malformed }
        return try data.map { song in
            let id: String?
            if song["type"] as? String == "songs" { id = song["id"] as? String }
            else if song["type"] as? String == "library-songs", let attrs = song["attributes"] as? [String: Any], let params = attrs["playParams"] as? [String: Any] { id = params["catalogId"] as? String }
            else { id = nil }
            guard let id, valid(id, pattern: "^[0-9]{1,20}$") else { throw ProbeError.malformed }
            return id
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
