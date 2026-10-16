import Foundation

final class WebMusicService {
    let store: any WebCredentialStorage
    let lock: any WebOperationLock
    let transport: any WebTransport
    let artwork: (any ArtworkService)?
    init(store: any WebCredentialStorage, lock: any WebOperationLock, transport: any WebTransport, artwork: (any ArtworkService)? = nil) {
        self.store = store; self.lock = lock; self.transport = transport; self.artwork = artwork
    }
    private func valid(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
    private func catalogID(_ value: String) -> Bool { valid(value, "^[0-9]{1,20}$") }
    private func playlistID(_ value: String) -> Bool { valid(value, "^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$") }
    private func validate(_ request: WebMusicRequest) throws {
        guard ["status", "checkConnection", "inspectTracks", "ensurePlaylist", "addTrackToPlaylist", "rebindPlaylist", "playlistCover", "saveConnection", "disconnect", "catalogArtists", "catalogReleases", "catalogTracks"].contains(request.action),
              request.generation == nil || UUID(uuidString: request.generation!) != nil,
              request.jobId == nil || UUID(uuidString: request.jobId!) != nil,
              request.jobId == nil || ["ensurePlaylist", "playlistCover"].contains(request.action),
              request.coverMode == nil || request.action == "playlistCover",
              request.credentials == nil || request.action == "saveConnection" else { throw WebMusicError.invalidInput }
        try validateCatalogRequest(request)
        if let ids = request.catalogIds { guard ids.count <= 1000, !ids.isEmpty, ids.allSatisfy(catalogID) else { throw WebMusicError.invalidInput } }
        if let id = request.playlistId { guard playlistID(id) else { throw WebMusicError.invalidInput } }
        if let name = request.name {
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf8.count <= 512,
                  !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw WebMusicError.invalidInput }
        }
        switch request.action {
        case "inspectTracks": guard request.catalogIds != nil else { throw WebMusicError.invalidInput }
        case "ensurePlaylist": guard request.catalogIds != nil, request.playlistId != nil || request.name != nil else { throw WebMusicError.invalidInput }
        case "playlistCover":
            guard request.jobId != nil, request.generation != nil, request.name != nil,
                  let id = request.playlistId, valid(id, "^p\\.[A-Za-z0-9][A-Za-z0-9.-]{0,125}$"),
                  request.catalogIds != nil, request.coverMode != nil, request.position == nil,
                  request.reconcileOnly == nil else { throw WebMusicError.invalidInput }
        case "addTrackToPlaylist":
            guard request.playlistId != nil, let ids = request.catalogIds, let position = request.position,
                  position >= 0, position < ids.count else { throw WebMusicError.invalidInput }
        case "rebindPlaylist":
            guard request.playlistId != nil, let ids = request.catalogIds, let position = request.position,
                  position >= 0, position <= ids.count else { throw WebMusicError.invalidInput }
        case "saveConnection": guard request.credentials != nil else { throw WebMusicError.invalidInput }
        default: break
        }
    }
    private func record() throws -> WebCredentialRecord? {
        do {
            guard let data = try store.read() else { return nil }
            guard data.count <= 40_000, let record = try? JSONDecoder().decode(WebCredentialRecord.self, from: data), UUID(uuidString: record.generation) != nil else { throw WebMusicError.storage }
            _ = try WebCredentials.parse(bearer: record.credentials.bearer, user: record.credentials.user)
            return record
        } catch { throw WebMusicError.storage }
    }
    private func status(_ record: WebCredentialRecord?, storefront: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["platform": "darwin", "running": false, "accessibility": false, "automation": "unknown", "backend": "web-session", "connection": record == nil ? "missing" : "saved", "message": record == nil ? "Connect to Apple Music to create playlists." : "Apple Music connection saved. Check it before creating a playlist."]
        if let record { result["generation"] = record.generation }
        if let storefront { result["storefront"] = storefront }
        return result
    }
    func handle(_ request: WebMusicRequest) async throws -> [String: Any] {
        try validate(request)
        try lock.acquire(); defer { lock.release() }
        let current = try record()
        if request.action == "status" { return status(current) }
        guard request.generation == current?.generation else { throw WebMusicError.generationChanged }
        if request.action == "disconnect" {
            do { try store.delete() } catch { throw WebMusicError.storage }
            return status(nil)
        }
        if request.action == "saveConnection" {
            let candidate = try WebCredentials.parse(bearer: request.credentials!.bearer, user: request.credentials!.user)
            let storefront = try await storefront(candidate)
            let fresh = WebCredentialRecord(credentials: candidate, generation: UUID().uuidString)
            do { try store.save(JSONEncoder().encode(fresh)) } catch { throw WebMusicError.storage }
            return status(fresh, storefront: storefront)
        }
        guard let current else { throw WebMusicError.missing }
        let credentials = current.credentials
        switch request.action {
        case "catalogArtists", "catalogReleases", "catalogTracks":
            return try await catalog(request, credentials: credentials)
        case "checkConnection": return ["generation": current.generation, "storefront": try await storefront(credentials)]
        case "inspectTracks":
            let storefront = try await storefront(credentials)
            let ids = request.catalogIds!
            var unique = Set<String>()
            let lookup = ids.filter { unique.insert($0).inserted }
            var available = Set<String>()
            var seen = Set<String>()
            for start in stride(from: 0, to: lookup.count, by: 100) {
                let batch = Array(lookup[start..<min(start + 100, lookup.count)])
                let object = try await json(path: "/v1/catalog/\(storefront)/songs", query: [URLQueryItem(name: "ids", value: batch.joined(separator: ","))], credentials: credentials)
                guard object["next"] == nil, let songs = object["data"] as? [[String: Any]], songs.count <= batch.count else { throw WebMusicError.malformed }
                for song in songs {
                    guard song["type"] as? String == "songs", let id = song["id"] as? String, batch.contains(id), seen.insert(id).inserted else { throw WebMusicError.malformed }
                    let params = (song["attributes"] as? [String: Any])?["playParams"] as? [String: Any]
                    if params?["id"] as? String == id && params?["kind"] as? String == "song" { available.insert(id) }
                }
            }
            let count = ids.filter { available.contains($0) }.count
            return ["generation": current.generation, "storefront": storefront, "total": ids.count, "availableCatalogTracks": count, "unavailableCatalogTracks": ids.count - count, "unavailableCatalogIds": Array(Set(ids.filter { !available.contains($0) })).sorted(), "newLibraryAdditions": 0, "existingLibrarySongs": 0]
        case "ensurePlaylist":
            if let id = request.playlistId {
                let playlist = try await playlist(id, credentials: credentials)
                return ["id": id, "name": (playlist["attributes"] as? [String: Any])?["name"] as? String ?? request.name ?? "Apple Music playlist"]
            }
            var attributes: [String: Any] = ["name": request.name!]
            if let jobID = request.jobId { attributes["description"] = "Wavelength playlist job " + UUID(uuidString: jobID)!.uuidString }
            let object = try await json(path: "/v1/me/library/playlists", method: "POST", body: ["attributes": attributes, "relationships": ["tracks": ["data": [["id": request.catalogIds![0], "type": "songs"]]]]], credentials: credentials)
            guard let rows = object["data"] as? [[String: Any]], rows.count == 1, rows[0]["type"] as? String == "library-playlists", let id = rows[0]["id"] as? String, playlistID(id) else { throw WebMusicError.malformed.withUncertainty(true) }
            return ["id": id, "name": request.name!]
        case "rebindPlaylist":
            _ = try await playlist(request.playlistId!, credentials: credentials)
            let contents = try await tracks(request.playlistId!, credentials: credentials)
            let prefix = Array(request.catalogIds!.prefix(request.position!)), extended = Array(request.catalogIds!.prefix(request.position! + 1))
            guard contents.map(\.catalogID) == prefix || contents.map(\.catalogID) == extended else { throw WebMusicError(code: "malformed", message: "The playlist contents conflict with this job's expected order.") }
            return ["generation": current.generation]
        case "addTrackToPlaylist": return await append(request, credentials: credentials)
        case "playlistCover": return await cover(request, credentials: credentials)
        default: throw WebMusicError.invalidInput
        }
    }
    private func makeRequest(path: String, method: String, query: [URLQueryItem], body: [String: Any]?, credentials: WebCredentials) throws -> URLRequest {
        let catalogRead = valid(path, "^/v1/catalog/(au|us|gb|ca|jp|de)/(search|artists/[1-9][0-9]{0,15}/albums|albums/[1-9][0-9]{0,15}/tracks)$")
        let allowed = path == "/v1/me/storefront" || path == "/v1/me/library/playlists" || valid(path, "^/v1/catalog/[a-z]{2}/songs$") || valid(path, "^/v1/me/library/playlists/[A-Za-z0-9][A-Za-z0-9.-]{0,127}(/tracks)?$") || catalogRead && method == "GET"
        guard allowed, method == "GET" || method == "POST" else { throw WebMusicError.invalidInput }
        var components = URLComponents(string: "https://amp-api.music.apple.com" + path)!
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url, url.absoluteString.utf8.count <= 8192 else { throw WebMusicError.invalidInput }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpShouldHandleCookies = false
        request.setValue("Bearer " + credentials.bearer, forHTTPHeaderField: "Authorization")
        request.setValue(credentials.user, forHTTPHeaderField: "Media-User-Token")
        request.setValue("https://music.apple.com", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            guard request.httpBody!.count <= 128 * 1024 else { throw WebMusicError.invalidInput }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }
    private func send(path: String, method: String = "GET", query: [URLQueryItem] = [], body: [String: Any]? = nil, credentials: WebCredentials) async throws -> Data {
        let request = try makeRequest(path: path, method: method, query: query, body: body, credentials: credentials)
        let data: Data, response: HTTPURLResponse
        do { (data, response) = try await transport.send(request) }
        catch { throw WebMusicError.transport.withUncertainty(method == "POST") }
        guard response.url == request.url else { throw WebMusicError.unavailable.withUncertainty(method == "POST") }
        switch response.statusCode {
        case 200...299: break
        case 300...399: throw WebMusicError.unavailable
        case 401, 403: throw WebMusicError.rejected
        case 404: throw WebMusicError.missing
        case 400, 405, 409, 422, 429: throw WebMusicError.unavailable
        default: throw WebMusicError.unavailable.withUncertainty(method == "POST")
        }
        guard data.count <= 2_000_000 else { throw WebMusicError.malformed.withUncertainty(method == "POST") }
        return data
    }
    func json(path: String, method: String = "GET", query: [URLQueryItem] = [], body: [String: Any]? = nil, credentials: WebCredentials) async throws -> [String: Any] {
        let data = try await send(path: path, method: method, query: query, body: body, credentials: credentials)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw WebMusicError.malformed.withUncertainty(method == "POST") }
        return object
    }
    func storefront(_ credentials: WebCredentials) async throws -> String {
        let object = try await json(path: "/v1/me/storefront", credentials: credentials)
        guard let rows = object["data"] as? [[String: Any]], rows.count == 1, rows[0]["type"] as? String == "storefronts", let id = rows[0]["id"] as? String, valid(id, "^[a-z]{2}$") else { throw WebMusicError.malformed }
        return id
    }
    private func playlist(_ id: String, credentials: WebCredentials) async throws -> [String: Any] {
        let object = try await json(path: "/v1/me/library/playlists/\(id)", credentials: credentials)
        guard let rows = object["data"] as? [[String: Any]], rows.count == 1, rows[0]["type"] as? String == "library-playlists", rows[0]["id"] as? String == id else { throw WebMusicError.malformed }
        return rows[0]
    }
    private struct Track { let catalogID: String; let libraryID: String?; let artwork: ArtworkTrack? }
    private func tracks(_ id: String, credentials: WebCredentials, includeArtwork: Bool = false) async throws -> [Track] {
        let path = "/v1/me/library/playlists/\(id)/tracks"
        var query = [URLQueryItem(name: "limit", value: "100")]
        var seen = Set<String>(), tracks: [Track] = []
        for _ in 0..<20 {
            let marker = query.map { $0.name + "=" + ($0.value ?? "") }.joined(separator: "&")
            guard seen.insert(marker).inserted else { throw WebMusicError.malformed }
            let object = try await json(path: path, query: query, credentials: credentials)
            guard let rows = object["data"] as? [[String: Any]], rows.count <= 100 else { throw WebMusicError.malformed }
            for row in rows {
                let type = row["type"] as? String
                let params = (row["attributes"] as? [String: Any])?["playParams"] as? [String: Any]
                let catalog = type == "songs" ? row["id"] as? String : type == "library-songs" ? params?["catalogId"] as? String : nil
                guard let catalog, catalogID(catalog) else { throw WebMusicError.malformed }
                let library = type == "library-songs" ? row["id"] as? String : nil
                if let library { guard valid(library, "^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$") else { throw WebMusicError.malformed } }
                let artwork = includeArtwork ? try artworkTrack(row["attributes"] as? [String: Any]) : nil
                tracks.append(Track(catalogID: catalog, libraryID: library, artwork: artwork))
                guard tracks.count <= 1000 else { throw WebMusicError.malformed }
            }
            guard let next = object["next"] else { return tracks }
            guard let next = next as? String, next.utf8.count <= 1024,
                  let components = URLComponents(string: next), components.fragment == nil, components.user == nil, components.password == nil,
                  components.path == path, components.scheme == nil && components.host == nil || components.scheme == "https" && components.host == "amp-api.music.apple.com" && (components.port == nil || components.port == 443),
                  let items = components.queryItems, !items.isEmpty, items.count <= 2,
                  Set(items.map(\.name)).count == items.count,
                  items.allSatisfy({ item in
                      guard let value = item.value, valid(value, "^[0-9]{1,6}$"), let number = Int(value) else { return false }
                      return item.name == "offset" ? number <= 1000 : item.name == "limit" && number > 0 && number <= 100
                  }), items.contains(where: { $0.name == "offset" }) else { throw WebMusicError.malformed }
            query = items
        }
        throw WebMusicError.malformed
    }
    private func artworkTrack(_ attributes: [String: Any]?) throws -> ArtworkTrack {
        func text(_ key: String) throws -> String {
            guard let value = attributes?[key] as? String, value.utf8.count <= 4096,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WebMusicError.malformed }
            return value
        }
        guard let duration = attributes?["durationInMillis"] as? NSNumber,
              CFGetTypeID(duration) != CFBooleanGetTypeID(), duration.doubleValue.isFinite,
              duration.doubleValue > 0, duration.doubleValue <= 86_400_000 else { throw WebMusicError.malformed }
        return try ArtworkTrack(title: text("name"), artist: text("artistName"), album: text("albumName"), durationSeconds: duration.doubleValue / 1000)
    }
    private func artworkResult(_ result: ArtworkResult) -> [String: Any] {
        guard ["verified", "blocked", "uncertain"].contains(result.state),
              valid(result.code, "^[a-z][a-z0-9-]{0,63}$"),
              result.imageHash == nil || valid(result.imageHash!, "^[a-f0-9]{64}$") else {
            return ["state": "uncertain", "code": "malformed", "writeAttempted": result.writeAttempted]
        }
        var value: [String: Any] = ["state": result.state, "code": result.code, "writeAttempted": result.writeAttempted]
        if let hash = result.imageHash { value["imageHash"] = hash }
        return value
    }
    private func cover(_ request: WebMusicRequest, credentials: WebCredentials) async -> [String: Any] {
        let mode = request.coverMode!
        let target: ArtworkTarget
        do {
            let playlist = try await playlist(request.playlistId!, credentials: credentials)
            let attributes = playlist["attributes"] as? [String: Any]
            let description = attributes?["description"] as? String ?? (attributes?["description"] as? [String: Any])?["standard"] as? String
            let jobID = UUID(uuidString: request.jobId!)!.uuidString
            guard let canEdit = attributes?["canEdit"] as? NSNumber,
                  CFGetTypeID(canEdit) == CFBooleanGetTypeID(), canEdit.boolValue,
                  attributes?["name"] as? String == request.name!,
                  description == "Wavelength playlist job " + jobID else { throw WebMusicError.malformed }
            let contents = try await tracks(request.playlistId!, credentials: credentials, includeArtwork: true)
            guard contents.map(\.catalogID) == request.catalogIds! else { throw WebMusicError.malformed }
            target = ArtworkTarget(jobID: jobID, playlistID: request.playlistId!, name: request.name!, tracks: contents.map { $0.artwork! })
            guard artwork != nil else { throw WebMusicError.unavailable }
        } catch {
            return artworkResult(ArtworkResult(state: mode == .check ? "uncertain" : "blocked", code: (error as? WebMusicError)?.code ?? "unavailable", writeAttempted: false, imageHash: nil))
        }
        return artworkResult(await artwork!.handle(target, mode: mode))
    }
    private func append(_ request: WebMusicRequest, credentials: WebCredentials) async -> [String: Any] {
        let position = request.position!, ids = request.catalogIds!, id = request.playlistId!
        let prefix = Array(ids.prefix(position)), extended = Array(ids.prefix(position + 1))
        func outcome(_ kind: String, _ message: String) -> [String: Any] { ["kind": kind, "message": message] }
        func confirmed(_ tracks: [Track], _ alreadyPresent: Bool) -> [String: Any] {
            var result: [String: Any] = ["kind": "confirmed", "catalogId": ids[position], "alreadyPresent": alreadyPresent]
            if let libraryID = tracks[position].libraryID { result["libraryId"] = libraryID }
            return result
        }
        do {
            let before = try await tracks(id, credentials: credentials), contents = before.map(\.catalogID)
            if contents == extended { return confirmed(before, true) }
            guard contents == prefix else { return outcome("conflict", "The playlist contents conflict with this job's expected order.") }
            if request.reconcileOnly == true { return outcome("uncertain", "The previous song addition is not visible yet. Inspect Apple Music before continuing.") }
        } catch let error as WebMusicError {
            return outcome(request.reconcileOnly == true ? "uncertain" : error.code == "malformed" ? "conflict" : "not-added", error.message)
        } catch { return outcome(request.reconcileOnly == true ? "uncertain" : "not-added", WebMusicError.unavailable.message) }
        do {
            _ = try await send(path: "/v1/me/library/playlists/\(id)/tracks", method: "POST", body: ["data": [["id": ids[position], "type": "songs"]]], credentials: credentials)
        } catch let error as WebMusicError {
            if !error.uncertain { return outcome("not-added", error.message) }
        } catch {}
        do {
            let after = try await tracks(id, credentials: credentials)
            if after.map(\.catalogID) == extended { return confirmed(after, false) }
            if after.map(\.catalogID) != prefix { return outcome("conflict", "The playlist contents changed during the song addition. Inspect Apple Music.") }
        } catch let error as WebMusicError {
            if error.code == "malformed" { return outcome("conflict", "The playlist's catalog identities or pagination could not be established. Inspect Apple Music.") }
        } catch {}
        return outcome("uncertain", "The song addition could not be confirmed. Inspect Apple Music before continuing.")
    }
}

final class WebURLSessionTransport: NSObject, WebTransport, URLSessionTaskDelegate {
    private let configuration: URLSessionConfiguration
    init(configuration: URLSessionConfiguration = .ephemeral) { self.configuration = configuration; super.init() }
    private lazy var session: URLSession = {
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse, http.expectedContentLength <= 2_000_000 else { throw WebMusicError.malformed }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_000_000 else { throw WebMusicError.malformed }
            data.append(byte)
        }
        return (data, http)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
