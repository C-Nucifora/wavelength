import Foundation
import Darwin
import Security
import LocalAuthentication

final class FakeWebStore: WebCredentialStorage {
    var data: Data?
    var saves = 0
    init(_ record: WebCredentialRecord? = nil) { data = record.flatMap { try? JSONEncoder().encode($0) } }
    func read() throws -> Data? { data }
    func save(_ data: Data) throws { self.data = data; saves += 1 }
    func delete() throws { data = nil }
}
final class FakeWebLock: WebOperationLock {
    var busy = false
    var held = false
    func acquire() throws { if busy { throw WebMusicError(code: "busy", message: "Busy.") }; held = true }
    func release() { held = false }
}
final class FakeWebTransport: WebTransport {
    var responses: [(Int, String)]
    var requests: [URLRequest] = []
    var failure = false
    var lock: FakeWebLock?
    init(_ responses: [(Int, String)] = []) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        precondition(lock == nil || lock!.held, "The operation lock must cover all network requests")
        requests.append(request)
        if failure { throw NSError(domain: "fake-token-secret", code: 1) }
        precondition(!responses.isEmpty, "Unexpected request")
        let (status, body) = responses.removeFirst()
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class FakeArtworkService: ArtworkService {
    let lock: FakeWebLock
    var targets: [ArtworkTarget] = []
    var modes: [ArtworkMode] = []
    var result = ArtworkResult(state: "verified", code: "verified", writeAttempted: true, imageHash: String(repeating: "a", count: 64))
    init(lock: FakeWebLock) { self.lock = lock }
    func handle(_ target: ArtworkTarget, mode: ArtworkMode) async -> ArtworkResult {
        precondition(lock.held, "The operation lock must cover native artwork handling")
        targets.append(target); modes.append(mode)
        return result
    }
}

final class WebFixtureProtocol: URLProtocol {
    static var sawCleanRequest = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.sawCleanRequest = request.url?.host == "amp-api.music.apple.com" && request.value(forHTTPHeaderField: "Cookie") == nil
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"data":[{"id":"au","type":"storefronts"}]}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct WebMusicChecks {
    static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !value() { throw NSError(domain: message, code: 1) }
    }
    static func checkCatalog(_ record: WebCredentialRecord) async throws {
        let storefront = #"{"data":[{"id":"au","type":"storefronts"}]}"#
        func encoded(_ value: [String: Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
        func request(_ action: String, _ fields: [String: Any] = [:]) throws -> WebMusicRequest {
            try WebMusicRequest.decode(Data(try encoded(fields.merging(["action": action, "generation": record.generation, "country": "AU"]) { old, _ in old }).utf8))
        }
        let network = FakeWebTransport(), lock = FakeWebLock(), store = FakeWebStore(record)
        network.lock = lock
        let service = WebMusicService(store: store, lock: lock, transport: network)
        let artist: [String: Any] = ["id": "42", "type": "artists", "attributes": ["name": "Fixture Artist", "url": "https://music.apple.com/au/artist/42", "artwork": ["url": "https://is1-ssl.mzstatic.com/image/{w}x{h}bb.jpg"]]]
        let search = try request("catalogArtists", ["term": "Fixture Artist"])
        network.responses = [(200, storefront), (200, try encoded(["results": ["artists": ["data": [artist]]]]))]
        let found = try await service.handle(search)
        try expect(found["generation"] as? String == record.generation && found["storefront"] as? String == "au" && (found["artists"] as? [[String: Any]])?.first?["id"] as? Int == 42, "catalog search returns numeric identity with verified storefront")
        let searchURL = URLComponents(url: network.requests.last!.url!, resolvingAgainstBaseURL: false)!
        try expect(searchURL.path == "/v1/catalog/au/search" && searchURL.queryItems?.contains(URLQueryItem(name: "types", value: "artists")) == true && searchURL.queryItems?.contains(URLQueryItem(name: "limit", value: "25")) == true, "search uses fixed artist catalog route and bounded page")
        let unicodeTerm = String(repeating: "音", count: 120)
        network.responses = [(200, storefront), (200, "{\"results\":{}}")]
        _ = try await service.handle(try request("catalogArtists", ["term": unicodeTerm]))
        try expect(URLComponents(url: network.requests.last!.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "term" }?.value == unicodeTerm, "search accepts 120 UTF-16 units regardless of UTF-8 byte count")
        let beforeLongTerm = network.requests.count
        network.responses = [(200, storefront), (200, "{\"results\":{}}")]
        do { _ = try await service.handle(try request("catalogArtists", ["term": String(repeating: "🎵", count: 61)])); throw NSError(domain: "overlong UTF-16 term accepted", code: 1) }
        catch let error as WebMusicError { try expect(error == .invalidInput, "search rejects more than 120 UTF-16 units") }
        try expect(network.requests.count == beforeLongTerm, "overlong Unicode search causes no external reads")
        let owners: [String: Any] = ["artists": ["data": [["id": "42", "type": "artists"]]]]
        let album: [String: Any] = ["id": "70", "type": "albums", "attributes": ["name": "Live EP Deluxe", "releaseDate": "2024-02-29", "trackCount": 2, "url": "https://music.apple.com/au/album/70"], "relationships": owners]
        let releases = try request("catalogReleases", ["artistId": "42"])
        var appearance = album; appearance["id"] = "71"; appearance["relationships"] = ["artists": ["data": [["id": "99", "type": "artists"]]]]
        network.responses = [(200, storefront), (200, try encoded(["data": [album, appearance], "next": "/v1/catalog/au/artists/42/albums?offset=2&limit=25&include=artists"]))]
        let page = try await service.handle(releases)
        try expect((page["releases"] as? [[String: Any]])?.map { $0["id"] as? Int } == [70] && page["nextOffset"] as? Int == 2, "release page preserves editions and filters albums by artist relationship")
        let song: [String: Any] = ["id": "80", "type": "songs", "attributes": ["name": "Song", "artistName": "Fixture Artist", "albumName": "Live EP Deluxe", "durationInMillis": 123_456, "discNumber": 1, "trackNumber": 1, "url": "https://music.apple.com/au/song/80"], "relationships": owners]
        let tracks = try request("catalogTracks", ["releaseId": "70"])
        network.responses = [(200, storefront), (200, try encoded(["data": [song, ["id": "81", "type": "music-videos"]]]))]
        let songs = try await service.handle(tracks)
        let track = (songs["tracks"] as? [[String: Any]])?.first
        try expect(track?["id"] as? Int == 80 && track?["artistId"] as? Int == 42 && track?["durationMs"] as? Int == 123_456 && songs["skippedMusicVideos"] as? Int == 1, "track page uses song artist identity and explicitly counts skipped videos")
        for action in [search, releases, tracks] {
            network.responses = [(200, #"{"data":[{"id":"us","type":"storefronts"}]}"#)]
            let calls = network.requests.count
            do { _ = try await service.handle(action); throw NSError(domain: "storefront mismatch accepted", code: 1) }
            catch let error as WebMusicError { try expect(error.code == "storefront-mismatch", "every catalog page rejects mismatched account storefront") }
            try expect(network.requests.count == calls + 1, "storefront mismatch prevents catalog request")
        }
        for next in ["https://evil.example/v1/catalog/au/artists/42/albums?offset=25", "/v1/catalog/au/artists/99/albums?offset=25", "/v1/catalog/au/artists/42/albums?offset=0", "/v1/catalog/au/artists/42/albums?offset=1001", "/v1/catalog/au/artists/42/albums?offset=2&evil=1", "/v1/catalog/au/artists/42/albums?offset=2&include=tracks", "/v1/catalog/au/artists/42/albums?offset=2&offset=3"] {
            network.responses = [(200, storefront), (200, try encoded(["data": [album, appearance], "next": next]))]
            do { _ = try await service.handle(releases); throw NSError(domain: "unsafe pagination accepted", code: 1) }
            catch let error as WebMusicError { try expect(error == .malformed, "pagination rejects host path query and offset changes") }
        }
        for (key, value) in [("releaseDate", "2024" as Any), ("releaseDate", "2024-02-30"), ("trackCount", true), ("name", " "), ("url", "javascript:bad")] {
            var bad = album, attributes = album["attributes"] as! [String: Any]; attributes[key] = value; bad["attributes"] = attributes
            network.responses = [(200, storefront), (200, try encoded(["data": [bad]]))]
            do { _ = try await service.handle(releases); throw NSError(domain: "bad release metadata accepted", code: 1) }
            catch let error as WebMusicError { try expect(error.code == (key == "releaseDate" ? "catalog-date" : "malformed"), "release dates identify the chronology failure and other malformed metadata stays rejected") }
        }
        for id in ["0", "-1", "9007199254740992", "01"] {
            var bad = artist; bad["id"] = id
            network.responses = [(200, storefront), (200, try encoded(["results": ["artists": ["data": [bad]]]]))]
            do { _ = try await service.handle(search); throw NSError(domain: "unsafe artist ID accepted", code: 1) }
            catch let error as WebMusicError { try expect(error == .malformed, "catalog result IDs are strict positive safe integers") }
        }
        for fields: [String: Any] in [["country": "au", "term": "Artist"], ["country": "FR", "term": "Artist"], ["term": " "], ["term": "Artist", "releaseId": "70"], ["term": "Artist", "offset": 0], ["term": "Artist", "catalogIds": ["1"]]] {
            let calls = network.requests.count
            do { _ = try await service.handle(try request("catalogArtists", fields)); throw NSError(domain: "invalid catalog request accepted", code: 1) }
            catch let error as WebMusicError { try expect(error == .invalidInput, "catalog request fields validate before effects") }
            try expect(network.requests.count == calls, "invalid catalog inputs cause no network request")
        }
        for country in ["AU", "US", "GB", "CA", "JP", "DE"] {
            network.responses = [(200, try encoded(["data": [["id": country.lowercased(), "type": "storefronts"]]])), (200, "{\"results\":{}}")]
            let empty = try await service.handle(try request("catalogArtists", ["country": country, "term": "Absent"]))
            try expect(empty["storefront"] as? String == country.lowercased() && (empty["artists"] as? [[String: Any]])?.isEmpty == true && network.requests.last?.url?.path == "/v1/catalog/\(country.lowercased())/search", "search uses the selected supported storefront")
        }
        try expect(network.requests.allSatisfy { $0.httpMethod == "GET" } && store.saves == 0 && !lock.held, "catalog discovery holds the lock and only reads")
    }
    static func checkRepeatedPreflight(_ record: WebCredentialRecord) async throws {
        let ids = (1...101).map(String.init) + ["1", "101"]
        func songs(_ ids: [String]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: ["data": ids.map { ["id": $0, "type": "songs", "attributes": ["playParams": ["id": $0, "kind": "song"]]] }]), as: UTF8.self)
        }
        let network = FakeWebTransport([(200, #"{"data":[{"id":"au","type":"storefronts"}]}"#), (200, try songs((1...100).map(String.init))), (200, try songs(["101"]))])
        let result = try await WebMusicService(store: FakeWebStore(record), lock: FakeWebLock(), transport: network).handle(WebMusicRequest(action: "inspectTracks", generation: record.generation, catalogIds: ids))
        try expect(result["availableCatalogTracks"] as? Int == 103 && result["total"] as? Int == 103, "preflight counts duplicate occurrences across batch boundaries")
        let queried = network.requests.dropFirst().flatMap { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "ids" }!.value!.split(separator: ",").map(String.init) }
        try expect(queried.count == 101 && Set(queried).count == 101, "preflight queries every unique identity once")
    }
    static func checkCompletion(_ record: WebCredentialRecord) async throws {
        let playlist = #"{"data":[{"id":"p.saved","type":"library-playlists"}]}"#
        let contents = #"{"data":[{"id":"1","type":"songs"},{"id":"2","type":"songs"}]}"#
        let network = FakeWebTransport([(200, playlist), (200, contents)])
        let lock = FakeWebLock(); network.lock = lock
        let service = WebMusicService(store: FakeWebStore(record), lock: lock, transport: network)
        var request = WebMusicRequest(action: "rebindPlaylist", generation: record.generation, catalogIds: ["1", "2"], position: 2, reconcileOnly: true, playlistId: "p.saved")
        let result = try await service.handle(request)
        try expect(result["generation"] as? String == record.generation, "all-confirmed rebind accepts complete order")
        try expect(network.requests.map { $0.url!.path } == ["/v1/me/library/playlists/p.saved", "/v1/me/library/playlists/p.saved/tracks"] && network.requests.allSatisfy { $0.httpMethod == "GET" }, "completion proves the exact saved library resource using only reads")
        for body in [#"{"data":[]}"#, #"{"data":[{"id":"1","type":"songs"}]}"#, #"{"data":[{"id":"2","type":"songs"},{"id":"1","type":"songs"}]}"#, #"{"data":[{"id":"1","type":"songs"},{"id":"2","type":"songs"},{"id":"3","type":"songs"}]}"#] {
            network.responses = [(200, playlist), (200, body)]
            do { _ = try await service.handle(request); throw NSError(domain: "wrong complete order accepted", code: 1) }
            catch let error as WebMusicError { try expect(error.code == "malformed", "completion rejects any nonexact full order") }
        }
        network.responses = [(200, playlist.replacingOccurrences(of: "p.saved", with: "p.other"))]
        do { _ = try await service.handle(request); throw NSError(domain: "wrong saved resource accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "malformed", "completion checks returned playlist ID") }
        let calls = network.requests.count
        request.generation = "22222222-2222-2222-2222-222222222222"
        do { _ = try await service.handle(request); throw NSError(domain: "stale completion accepted", code: 1) }
        catch let error as WebMusicError { try expect(error == .generationChanged, "completion requires current generation") }
        let append = WebMusicRequest(action: "addTrackToPlaylist", generation: record.generation, catalogIds: ["1", "2"], position: 2, reconcileOnly: true, playlistId: "p.saved")
        do { _ = try await service.handle(append); throw NSError(domain: "append at count accepted", code: 1) }
        catch let error as WebMusicError { try expect(error == .invalidInput, "append position stays strictly below count") }
        request.generation = record.generation; request.position = 3
        do { _ = try await service.handle(request); throw NSError(domain: "rebind beyond count accepted", code: 1) }
        catch let error as WebMusicError { try expect(error == .invalidInput, "rebind position cannot exceed count") }
        try expect(network.requests.count == calls, "invalid completion and append bounds cause no reads or writes")
    }
    static func checkArtwork(_ record: WebCredentialRecord) async throws {
        for json in [
            #"{"action":"status","unknown":null}"#,
            #"{"action":"status","jobId":null}"#,
            #"{"action":"status","coverMode":null}"#,
            #"{"action":"ensurePlaylist","coverMode":null}"#,
            #"{"action":"playlistCover","generation":"11111111-1111-1111-1111-111111111111","catalogIds":["1"],"playlistId":"p.created","name":"Fixture playlist","jobId":"33333333-3333-3333-3333-333333333333","coverMode":"apply","position":null}"#,
            #"{"action":"playlistCover","generation":"11111111-1111-1111-1111-111111111111","catalogIds":["1"],"playlistId":"p.created","name":"Fixture playlist","jobId":"33333333-3333-3333-3333-333333333333","coverMode":"apply","reconcileOnly":null}"#,
            #"{"action":"saveConnection","credentials":{"bearer":"fixture","user":"fixture","unknown":null}}"#,
        ] {
            do { _ = try WebMusicRequest.decode(Data(json.utf8)); throw NSError(domain: "invalid JSON fields accepted", code: 1) }
            catch let error as WebMusicError { try expect(error == .invalidInput, "JSON fields reject before external operations") }
        }
        let jobID = "33333333-3333-3333-3333-333333333333"
        let marker = "Wavelength playlist job " + jobID
        let lock = FakeWebLock(), network = FakeWebTransport(), artwork = FakeArtworkService(lock: lock)
        network.lock = lock
        let service = WebMusicService(store: FakeWebStore(record), lock: lock, transport: network, artwork: artwork)
        let request = WebMusicRequest(action: "playlistCover", generation: record.generation, catalogIds: ["1"], playlistId: "p.created", name: "Fixture playlist", jobId: jobID, coverMode: .apply)
        func playlist(_ attributes: [String: Any], id: String = "p.created", count: Int = 1) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: ["data": Array(repeating: ["id": id, "type": "library-playlists", "attributes": attributes], count: count)]), as: UTF8.self)
        }
        let attributes: [String: Any] = ["name": "Fixture playlist", "canEdit": true, "description": marker]
        let metadata: [String: Any] = ["name": "Cloud title", "artistName": "Cloud artist", "albumName": "Cloud album", "durationInMillis": 180_000]
        func tracks(_ metadata: [String: Any], ids: [String] = ["1"]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: ["data": ids.map { ["id": "i." + $0, "type": "library-songs", "attributes": metadata.merging(["playParams": ["catalogId": $0]]) { _, new in new }] }]), as: UTF8.self)
        }
        let validPlaylist = try playlist(attributes), validTracks = try tracks(metadata)
        network.responses = [(200, validPlaylist), (200, validTracks)]
        let result = try await service.handle(request)
        try expect(result["state"] as? String == "verified", "complete order accepts no remaining position")
        try expect(artwork.targets.count == 1 && artwork.targets[0].tracks == [ArtworkTrack(title: "Cloud title", artist: "Cloud artist", album: "Cloud album", durationSeconds: 180)], "canonical cloud metadata and milliseconds reach artwork")
        try expect(artwork.targets[0].jobID == jobID && artwork.targets[0].playlistID == "p.created" && artwork.targets[0].name == "Fixture playlist" && artwork.modes == [.apply], "artwork receives validated target identity and mode")
        let encoded = String(decoding: try JSONEncoder().encode(artwork.targets[0]), as: UTF8.self)
        try expect(!encoded.contains("fake-bearer") && !encoded.contains("fake-user") && !lock.held, "artwork target contains no credentials and releases lock")
        try expect(network.requests.allSatisfy { $0.httpMethod == "GET" }, "cloud cover preparation is read-only")
        var stale = request; stale.generation = "22222222-2222-2222-2222-222222222222"
        let calls = network.requests.count
        do { _ = try await service.handle(stale); throw NSError(domain: "stale cover accepted", code: 1) }
        catch let error as WebMusicError { try expect(error == .generationChanged, "cover preserves generation error") }
        try expect(network.requests.count == calls && artwork.targets.count == 1, "stale cover never enters artwork or network")
        func blocked(_ playlistBody: String, _ tracksBody: String = "") async throws {
            let count = artwork.targets.count
            network.responses = [(200, playlistBody)] + (tracksBody.isEmpty ? [] : [(200, tracksBody)])
            let result = try await service.handle(request)
            try expect(result["state"] as? String == "blocked" && result["writeAttempted"] as? Bool == false && artwork.targets.count == count, "invalid cloud target blocks before artwork")
        }
        for (key, value) in [("name", "Other playlist" as Any), ("description", "Wrong marker"), ("canEdit", false), ("canEdit", "true"), ("canEdit", 1), ("description", ["standard": 7]), ("description", ["short": marker]), ("description", [marker])] {
            var changed = attributes; changed[key] = value
            try await blocked(try playlist(changed))
        }
        try await blocked(try playlist(attributes, id: "p.other"))
        try await blocked(try playlist(attributes, count: 2))
        for key in ["name", "artistName", "albumName", "durationInMillis"] {
            var missing = metadata; missing.removeValue(forKey: key)
            try await blocked(validPlaylist, try tracks(missing))
        }
        for key in ["name", "artistName", "albumName"] {
            for value: Any in [" \n\t ", 123, String(repeating: "x", count: 4097)] {
                var changed = metadata; changed[key] = value
                try await blocked(validPlaylist, try tracks(changed))
            }
        }
        for value: Any in [0, -1, "180000", true] {
            var changed = metadata; changed["durationInMillis"] = value
            try await blocked(validPlaylist, try tracks(changed))
        }
        try await blocked(validPlaylist, validTracks.replacingOccurrences(of: "180000", with: "1e999"))
        try await blocked(validPlaylist, try tracks(metadata, ids: ["1", "2"]))
        try await blocked(validPlaylist, try tracks(metadata, ids: ["2"]))
        var duplicate = request; duplicate.catalogIds = ["1", "1"]
        network.responses = [(200, validPlaylist), (200, try tracks(metadata, ids: ["1", "1"]))]
        let duplicates = try await service.handle(duplicate)
        try expect(duplicates["state"] as? String == "verified" && artwork.targets.last?.tracks.count == 2, "complete duplicate order is preserved")
        var standard = attributes; standard["description"] = ["standard": marker]
        var check = request; check.coverMode = .check
        network.responses = [(200, try playlist(standard)), (200, validTracks)]
        _ = try await service.handle(check)
        try expect(artwork.modes.last == .check, "standard description and read-only mode accepted")
        var marked = WebMusicRequest(action: "ensurePlaylist", generation: record.generation, catalogIds: ["1"], name: "Fixture playlist", jobId: jobID.lowercased())
        network.responses = [(201, validPlaylist)]
        _ = try await service.handle(marked)
        let body = try JSONSerialization.jsonObject(with: network.requests.last!.httpBody!) as! [String: Any]
        try expect((body["attributes"] as? [String: Any])?["description"] as? String == marker, "creation persists canonical UUID marker")
        marked.coverMode = .apply
        var badRequests = [marked]
        for action in ["status", "checkConnection", "inspectTracks", "addTrackToPlaylist", "rebindPlaylist", "saveConnection", "disconnect"] {
            badRequests.append(WebMusicRequest(action: action, jobId: jobID))
            badRequests.append(WebMusicRequest(action: action, coverMode: .check))
        }
        var invalid = request; invalid.position = 0; badRequests.append(invalid)
        invalid = request; invalid.reconcileOnly = true; badRequests.append(invalid)
        invalid = request; invalid.jobId = "../bad"; badRequests.append(invalid)
        invalid = request; invalid.jobId = nil; badRequests.append(invalid)
        invalid = request; invalid.coverMode = nil; badRequests.append(invalid)
        invalid = request; invalid.generation = nil; badRequests.append(invalid)
        invalid = request; invalid.playlistId = "ordinary-id"; badRequests.append(invalid)
        invalid = request; invalid.name = nil; badRequests.append(invalid)
        invalid = request; invalid.catalogIds = []; badRequests.append(invalid)
        let beforeInvalid = network.requests.count
        for request in badRequests {
            do { _ = try await service.handle(request); throw NSError(domain: "invalid cover fields accepted", code: 1) }
            catch let error as WebMusicError { try expect(error == .invalidInput, "cover fields validate before effects") }
        }
        try expect(network.requests.count == beforeInvalid, "invalid requests cause no network calls")
        let failingNetwork = FakeWebTransport(); failingNetwork.failure = true
        let failing = WebMusicService(store: FakeWebStore(record), lock: lock, transport: failingNetwork, artwork: artwork)
        let failure = try await failing.handle(request)
        try expect(failure["state"] as? String == "blocked" && failure["code"] as? String == "transport" && failure["writeAttempted"] as? Bool == false, "transport preparation failure is typed and safe")
        try expect(!String(decoding: try JSONSerialization.data(withJSONObject: failure), as: UTF8.self).contains("fake-token"), "preparation errors do not expose underlying errors")
        let noArtworkNetwork = FakeWebTransport([(200, validPlaylist), (200, validTracks)])
        let noArtwork = WebMusicService(store: FakeWebStore(record), lock: lock, transport: noArtworkNetwork)
        let unavailable = try await noArtwork.handle(request)
        try expect(unavailable["state"] as? String == "blocked" && unavailable["writeAttempted"] as? Bool == false, "absent native service blocks safely")
        let uncertain = try await failing.handle(check)
        try expect(uncertain["state"] as? String == "uncertain" && uncertain["writeAttempted"] as? Bool == false, "failed read-only preparation cannot prove no older write")
        for value: Any in [86_400_001, "NaN", NSNull()] {
            var changed = metadata; changed["durationInMillis"] = value
            try await blocked(validPlaylist, try tracks(changed))
        }
        for nativeResult in [
            ArtworkResult(state: "verified", code: String(repeating: "x", count: 65), writeAttempted: true, imageHash: nil),
            ArtworkResult(state: "verified", code: "verified\n", writeAttempted: false, imageHash: nil),
            ArtworkResult(state: "unrecognized", code: "verified", writeAttempted: false, imageHash: nil),
            ArtworkResult(state: "verified", code: "verified", writeAttempted: true, imageHash: "not-a-sha256"),
        ] {
            artwork.result = nativeResult
            network.responses = [(200, validPlaylist), (200, validTracks)]
            let result = try await service.handle(request)
            try expect(result["state"] as? String == "uncertain" && result["code"] as? String == "malformed" && result["writeAttempted"] as? Bool == nativeResult.writeAttempted && result["imageHash"] == nil, "invalid native results remain bounded and preserve write intent")
        }
        let root = URL(fileURLWithPath: "/fixture/covers", isDirectory: true)
        try expect(try ArtworkPaths.directory(jobID: jobID.lowercased(), root: root).path == "/fixture/covers/" + jobID, "job paths use canonical UUIDs")
        do { _ = try ArtworkPaths.directory(jobID: "../escape", root: root); throw NSError(domain: "invalid job path accepted", code: 1) }
        catch let error as WebMusicError { try expect(error == .invalidInput, "job paths reject traversal") }
    }
    static func main() async throws {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--hold-lock" {
            let lock = WebFileLock(directory: URL(fileURLWithPath: CommandLine.arguments[2]))
            try lock.acquire()
            try FileHandle.standardOutput.write(contentsOf: Data([1]))
            _ = try FileHandle.standardInput.read(upToCount: 1)
            lock.release(); return
        }
        let parsed = try WebCredentials.parse(bearer: "  Bearer fake-bearer  ", user: " fake-user ")
        try expect(parsed.bearer == "fake-bearer" && parsed.user == "fake-user", "normalize header values")
        for (bearer, user) in [("Bearer", "user"), ("x\ny", "u"), ("b", "u v"), ("b", ""), (String(repeating: "x", count: 16_385), "u")] {
            do { _ = try WebCredentials.parse(bearer: bearer, user: user); throw NSError(domain: "invalid credential accepted", code: 1) }
            catch let error as WebMusicError { try expect(error.code == "invalid-input", "safe credential error") }
        }
        let record = WebCredentialRecord(credentials: parsed, generation: "11111111-1111-1111-1111-111111111111")
        try await checkRepeatedPreflight(record)
        try await checkCatalog(record)
        try await checkCompletion(record)
        try await checkArtwork(record)
        let store = FakeWebStore(record), lock = FakeWebLock(), network = FakeWebTransport()
        network.lock = lock
        let service = WebMusicService(store: store, lock: lock, transport: network)
        var request = WebMusicRequest(action: "checkConnection", generation: "22222222-2222-2222-2222-222222222222")
        do { _ = try await service.handle(request); throw NSError(domain: "stale generation accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "generation-changed" && !error.uncertain, "stale generation rejected") }
        try expect(network.requests.isEmpty && !lock.held, "stale generation starts no request")
        request.generation = record.generation; lock.busy = true
        do { _ = try await service.handle(request); throw NSError(domain: "busy lock accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "busy", "busy exclusion") }
        try expect(network.requests.isEmpty, "busy starts no request"); lock.busy = false
        network.responses = [(200, #"{"data":[{"id":"au","type":"storefronts"}]}"#)]
        let checked = try await service.handle(request)
        try expect(checked["storefront"] as? String == "au", "storefront read")
        let sent = network.requests[0]
        try expect(sent.url?.absoluteString == "https://amp-api.music.apple.com/v1/me/storefront", "fixed Apple host")
        try expect(sent.value(forHTTPHeaderField: "Origin") == "https://music.apple.com" && sent.value(forHTTPHeaderField: "Authorization") == "Bearer fake-bearer" && sent.value(forHTTPHeaderField: "Media-User-Token") == "fake-user", "headers and normalization")
        try expect(!sent.httpShouldHandleCookies, "cookies disabled")
        let empty = #"{"data":[]}"#
        let one = #"{"data":[{"type":"library-songs","id":"i.abc","attributes":{"playParams":{"catalogId":"1"}}}]}"#
        let two = #"{"data":[{"type":"songs","id":"1"},{"type":"library-songs","id":"i.xyz","attributes":{"playParams":{"catalogId":"2"}}}]}"#
        func operation(_ request: WebMusicRequest, _ responses: [(Int, String)]) async throws -> ([String: Any], FakeWebTransport) {
            let net = FakeWebTransport(responses)
            return (try await WebMusicService(store: FakeWebStore(record), lock: FakeWebLock(), transport: net).handle(request), net)
        }
        var append = WebMusicRequest(action: "addTrackToPlaylist", generation: record.generation, catalogIds: ["1", "2"], position: 1, reconcileOnly: false, playlistId: "p.abc")
        let (added, addNetwork) = try await operation(append, [(200, one), (204, ""), (200, two)])
        try expect(added["kind"] as? String == "confirmed" && added["catalogId"] as? String == "2" && added["alreadyPresent"] as? Bool == false, "append confirms catalog order")
        try expect(addNetwork.requests.map(\.httpMethod) == ["GET", "POST", "GET"], "one append then readback")
        let payload = try JSONSerialization.jsonObject(with: addNetwork.requests[1].httpBody!) as! [String: Any]
        try expect((payload["data"] as? [[String: String]]) == [["id": "2", "type": "songs"]], "append catalog payload")
        let (present, presentNetwork) = try await operation(append, [(200, two)])
        try expect(present["alreadyPresent"] as? Bool == true && presentNetwork.requests.count == 1, "already present avoids duplicate append")
        append.reconcileOnly = true
        let (unknown, reconcileNetwork) = try await operation(append, [(200, one)])
        try expect(unknown["kind"] as? String == "uncertain" && reconcileNetwork.requests.allSatisfy { $0.httpMethod == "GET" }, "absent reconciliation never posts")
        let (reconciled, _) = try await operation(append, [(200, two)])
        try expect(reconciled["kind"] as? String == "confirmed", "GET-only reconciliation confirms")
        append.reconcileOnly = false
        let (conflict, conflictNetwork) = try await operation(append, [(200, empty)])
        try expect(conflict["kind"] as? String == "conflict" && conflictNetwork.requests.count == 1, "missing preceding track blocks append")
        let (delayed, _) = try await operation(append, [(200, one), (204, ""), (200, one)])
        try expect(delayed["kind"] as? String == "uncertain", "204 with missing readback stays uncertain")
        let (postUnmapped, _) = try await operation(append, [(200, one), (204, ""), (200, #"{"data":[{"type":"library-songs","id":"i.abc"}]}"#)])
        try expect(postUnmapped["kind"] as? String == "conflict", "post-write missing mapping reports conflict")
        let (rejected, _) = try await operation(append, [(200, one), (403, "fake-token-secret")])
        try expect(rejected["kind"] as? String == "not-added", "definite rejection is not added")
        let (unmapped, _) = try await operation(append, [(200, #"{"data":[{"type":"library-songs","id":"i.abc"}]}"#)])
        try expect(unmapped["kind"] as? String == "conflict", "library ID is not catalog identity")
        let (paged, pageNetwork) = try await operation(append, [(200, #"{"data":[{"type":"songs","id":"1"}],"next":"/v1/me/library/playlists/p.abc/tracks?offset=1&limit=100"}"#), (200, #"{"data":[{"type":"songs","id":"2"}]}"#)])
        try expect(paged["kind"] as? String == "confirmed" && pageNetwork.requests.count == 2, "safe pagination confirms ordered prefix")
        let (unsafe, unsafeNetwork) = try await operation(append, [(200, #"{"data":[],"next":"https://evil.example/v1/me/library/playlists/p.abc/tracks"}"#)])
        try expect(unsafe["kind"] as? String == "conflict" && unsafeNetwork.requests.count == 1, "pagination cannot leak credentials")
        let (wrongOrder, _) = try await operation(append, [(200, #"{"data":[{"type":"songs","id":"2"},{"type":"songs","id":"1"}]}"#)])
        try expect(wrongOrder["kind"] as? String == "conflict", "wrong order blocks write")
        let create = WebMusicRequest(action: "ensurePlaylist", generation: record.generation, catalogIds: ["1", "2"], name: "Fixture playlist")
        let (created, createNetwork) = try await operation(create, [(201, #"{"data":[{"id":"p.created","type":"library-playlists","attributes":{"name":"Fixture playlist"}}]}"#)])
        try expect(created["id"] as? String == "p.created" && createNetwork.requests.count == 1, "create returns validated cloud ID")
        let createPayload = try JSONSerialization.jsonObject(with: createNetwork.requests[0].httpBody!) as! [String: Any]
        let relationships = createPayload["relationships"] as! [String: Any]
        try expect((relationships["tracks"] as! [String: Any])["data"] as? [[String: String]] == [["id": "1", "type": "songs"]], "create includes only the first catalog song")
        var existing = create; existing.playlistId = "p.created"
        let (existingPlaylist, existingNetwork) = try await operation(existing, [(200, #"{"data":[{"id":"p.created","type":"library-playlists"}]}"#)])
        try expect(existingPlaylist["id"] as? String == "p.created" && existingNetwork.requests.map(\.httpMethod) == ["GET"], "existing playlist route never inserts a seed")
        let seed = WebMusicRequest(action: "addTrackToPlaylist", generation: record.generation, catalogIds: ["1", "2"], position: 0, reconcileOnly: true, playlistId: "p.created")
        let (verifiedSeed, seedNetwork) = try await operation(seed, [(200, one)])
        try expect(verifiedSeed["kind"] as? String == "confirmed" && verifiedSeed["alreadyPresent"] as? Bool == true && seedNetwork.requests.map(\.httpMethod) == ["GET"], "seed is confirmed only by exact catalog read without appending")
        for response in [(200, empty), (404, ""), (200, #"{"data":[{"id":"i.unknown","type":"library-songs"}]}"#)] {
            let (result, net) = try await operation(seed, [response])
            try expect(result["kind"] as? String == "uncertain" && net.requests.map(\.httpMethod) == ["GET"], "missing or malformed seed read stays uncertain and never appends")
        }
        let duplicate = WebMusicRequest(action: "addTrackToPlaylist", generation: record.generation, catalogIds: ["1", "1", "2"], position: 1, reconcileOnly: false, playlistId: "p.created")
        let (repeated, repeatedNetwork) = try await operation(duplicate, [(200, one), (204, ""), (200, #"{"data":[{"id":"1","type":"songs"},{"id":"1","type":"songs"}]}"#)])
        try expect(repeated["kind"] as? String == "confirmed" && repeatedNetwork.requests.map(\.httpMethod) == ["GET", "POST", "GET"], "intentional second occurrence remains an ordered append")
        for (status, body, code, uncertain) in [(200, "{}", "malformed", true), (403, "secret", "rejected", false), (302, "secret", "unavailable", false), (500, "secret", "unavailable", true)] {
            do { _ = try await operation(create, [(status, body)]); throw NSError(domain: "unsafe create success", code: 1) }
            catch let error as WebMusicError { try expect(error.code == code && error.uncertain == uncertain && !error.message.contains("secret"), "safe create uncertainty") }
        }
        let rebind = WebMusicRequest(action: "rebindPlaylist", generation: record.generation, catalogIds: ["1", "2"], position: 1, playlistId: "p.abc")
        let (bound, bindNetwork) = try await operation(rebind, [(200, #"{"data":[{"id":"p.abc","type":"library-playlists"}]}"#), (200, one)])
        try expect(bound["generation"] as? String == record.generation && bindNetwork.requests.allSatisfy { $0.httpMethod == "GET" }, "rebind validates ownership and prefix read-only")
        let statusResult = try await service.handle(WebMusicRequest(action: "status"))
        try expect(statusResult["backend"] as? String == "web-session" && statusResult["connection"] as? String == "saved" && statusResult["generation"] as? String == record.generation, "status uses local saved record")
        network.responses = [(200, #"{"data":[{"id":"au","type":"storefronts"}]}"#), (200, #"{"data":[{"id":"1","type":"songs","attributes":{"playParams":{"id":"1","kind":"song"}}},{"id":"2","type":"songs","attributes":{"name":"Metadata only"}}]}"#)]
        let inspection = try await service.handle(WebMusicRequest(action: "inspectTracks", generation: record.generation, catalogIds: ["1", "2"]))
        try expect(inspection["availableCatalogTracks"] as? Int == 1 && inspection["unavailableCatalogTracks"] as? Int == 1 && inspection["newLibraryAdditions"] as? Int == 0, "catalog availability counts")
        try expect(inspection["unavailableCatalogIds"] as? [String] == ["2"], "catalog inspection identifies the metadata-only song")
        network.responses = [(200, #"{"data":[{"id":"au","type":"storefronts"}]}"#), (200, #"{"data":[{"id":"1","type":"songs","attributes":{"playParams":{"id":"1","kind":"song"}}}]}"#)]
        let missing = try await service.handle(WebMusicRequest(action: "inspectTracks", generation: record.generation, catalogIds: ["1", "2", "3", "2"]))
        try expect(missing["unavailableCatalogIds"] as? [String] == ["2", "3"] && missing["unavailableCatalogTracks"] as? Int == 3, "missing identities are unique while counts include repeated selected songs")
        let firstStore = FakeWebStore(), saveNetwork = FakeWebTransport([(200, #"{"data":[{"id":"au","type":"storefronts"}]}"#)])
        let saving = WebMusicService(store: firstStore, lock: FakeWebLock(), transport: saveNetwork)
        let saved = try await saving.handle(WebMusicRequest(action: "saveConnection", credentials: parsed))
        try expect(firstStore.saves == 1 && saved["generation"] as? String != nil && saved["storefront"] as? String == "au", "first save validates and atomically stores pair")
        do { _ = try await saving.handle(WebMusicRequest(action: "disconnect")); throw NSError(domain: "stale disconnect accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "generation-changed" && firstStore.data != nil, "disconnect protects generation") }
        _ = try await saving.handle(WebMusicRequest(action: "disconnect", generation: saved["generation"] as? String))
        try expect(firstStore.data == nil, "disconnect deletes only connection")
        let unknownNetwork = FakeWebTransport(); unknownNetwork.failure = true
        do { _ = try await WebMusicService(store: store, lock: lock, transport: unknownNetwork).handle(create); throw NSError(domain: "transport create accepted", code: 1) }
        catch let error as WebMusicError {
            try expect(error.code == "transport" && error.uncertain, "lost create result unknown")
            let serialized = try JSONSerialization.data(withJSONObject: error.envelope)
            try expect(!String(decoding: serialized, as: UTF8.self).contains("fake-token"), "underlying errors redacted")
        }
        let badInput = WebMusicRequest(action: "ensurePlaylist", generation: record.generation, catalogIds: ["1/../../me"], name: "Fixture")
        do { _ = try await service.handle(badInput); throw NSError(domain: "route injection accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "invalid-input", "invalid catalog ID blocked") }
        let expectedCalls = network.requests.count
        do { _ = try await service.handle(WebMusicRequest(action: "checkConnection")); throw NSError(domain: "missing generation accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "generation-changed" && network.requests.count == expectedCalls, "missing generation blocked before network") }
        let saveFailureStore = FakeWebStore(record)
        do {
            _ = try await WebMusicService(store: saveFailureStore, lock: FakeWebLock(), transport: FakeWebTransport([(403, "fake-token-secret")])).handle(WebMusicRequest(action: "saveConnection", generation: record.generation, credentials: parsed))
            throw NSError(domain: "failed save accepted", code: 1)
        } catch let error as WebMusicError { try expect(error.code == "rejected" && saveFailureStore.saves == 0, "failed candidate validation preserves saved record") }
        var keychainCalls: [WebKeychainOperation] = []
        let keychain = WebKeychainStorage { operation, query, attributes in
            precondition(query[kSecAttrService as String] as? String == "local.wavelength.apple-music.web-session.v1")
            precondition(query[kSecAttrAccount as String] as? String == "apple-music-web-session")
            precondition((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed == true)
            keychainCalls.append(operation)
            switch operation {
            case .read: return (errSecItemNotFound, nil)
            case .add: return (errSecDuplicateItem, nil)
            case .update:
                precondition(attributes?[kSecValueData as String] as? Data == Data("fixture".utf8))
                precondition(attributes?[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
                return (errSecSuccess, nil)
            case .delete: return (errSecItemNotFound, nil)
            }
        }
        try expect(try keychain.read() == nil, "missing dedicated Keychain item")
        try keychain.save(Data("fixture".utf8)); try keychain.delete()
        try expect(keychainCalls.count == 4, "Keychain replacement and absent delete")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WebFixtureProtocol.self]
        let realTransport = WebURLSessionTransport(configuration: configuration)
        let fixtureService = WebMusicService(store: store, lock: FakeWebLock(), transport: realTransport)
        let fixtureCheck = try await fixtureService.handle(WebMusicRequest(action: "checkConnection", generation: record.generation))
        try expect(fixtureCheck["storefront"] as? String == "au" && WebFixtureProtocol.sawCleanRequest, "URLSession uses the injected external-network boundary")
        var allowedRedirect = true
        realTransport.urlSession(URLSession(configuration: .ephemeral), task: URLSession(configuration: .ephemeral).dataTask(with: URL(string: "https://amp-api.music.apple.com/v1/me/storefront")!), willPerformHTTPRedirection: HTTPURLResponse(url: URL(string: "https://amp-api.music.apple.com/v1/me/storefront")!, statusCode: 302, httpVersion: nil, headerFields: nil)!, newRequest: URLRequest(url: URL(string: "https://amp-api.music.apple.com/v1/me/library/playlists")!)) { request in allowedRedirect = request != nil }
        try expect(!allowedRedirect, "same-host redirects are blocked")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-lock-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = WebFileLock(directory: directory), second = WebFileLock(directory: directory)
        try first.acquire()
        do { try second.acquire(); throw NSError(domain: "lock contention accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "busy", "real flock contention") }
        first.release(); try second.acquire(); second.release()
        let child = Process(), ready = Pipe(), release = Pipe()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--hold-lock", directory.path]
        child.standardOutput = ready; child.standardInput = release
        try child.run()
        try expect(try ready.fileHandleForReading.read(upToCount: 1) == Data([1]), "child holds lock")
        do { try first.acquire(); throw NSError(domain: "interprocess contention accepted", code: 1) }
        catch let error as WebMusicError { try expect(error.code == "busy", "interprocess exclusion") }
        try release.fileHandleForWriting.write(contentsOf: Data([1])); child.waitUntilExit()
        try expect(child.terminationStatus == 0, "child releases lock")
        try first.acquire(); first.release()
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        try expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700, "private lock directory")
        print("Web music boundary checks passed")
    }
}
