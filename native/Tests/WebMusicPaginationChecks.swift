import Foundation

private final class PaginationStore: WebCredentialStorage {
    let bytes: Data
    init(_ record: WebCredentialRecord) throws { bytes = try JSONEncoder().encode(record) }
    func read() throws -> Data? { bytes }
    func save(_ data: Data) throws { preconditionFailure("Unexpected storage write") }
    func delete() throws { preconditionFailure("Unexpected storage delete") }
}
private final class PaginationLock: WebOperationLock {
    var held = false
    func acquire() throws { precondition(!held); held = true }
    func release() { precondition(held); held = false }
}
private final class PaginationTransport: WebTransport {
    var pages: [[String: Any]]
    let lock: PaginationLock
    var writes = 0
    var reads = 0
    init(_ pages: [[String: Any]], lock: PaginationLock) { self.pages = pages; self.lock = lock }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        precondition(lock.held && request.url!.host == "amp-api.music.apple.com")
        let body: Data, status: Int
        if request.httpMethod == "POST" {
            precondition(request.url!.path == "/v1/me/library/playlists/p.synthetic/tracks")
            writes += 1; precondition(writes == 1); body = Data(); status = 204
        } else {
            precondition(request.httpMethod == "GET" && !pages.isEmpty)
            reads += 1; body = try JSONSerialization.data(withJSONObject: pages.removeFirst()); status = 200
        }
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
private final class TruncatedPlaylistTransport: WebTransport {
    let lock: PaginationLock
    let truncateBefore: Bool
    var actual: [String]
    var writes = 0
    var reads = 0
    init(truncateBefore: Bool, lock: PaginationLock) {
        self.truncateBefore = truncateBefore; self.lock = lock
        actual = truncateBefore ? ["1", "2"] : ["1"]
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        precondition(lock.held && request.url!.host == "amp-api.music.apple.com" && request.url!.path == "/v1/me/library/playlists/p.synthetic/tracks")
        let body: Data, status: Int
        if request.httpMethod == "POST" {
            writes += 1; precondition(writes == 1)
            actual.append("2")
            if !truncateBefore { actual.append("3") }
            body = Data(); status = 204
        } else {
            precondition(request.httpMethod == "GET" && reads < 3)
            reads += 1
            let visible = truncateBefore || writes > 0 ? Array(actual.dropLast()) : actual
            body = try JSONSerialization.data(withJSONObject: ["data": visible.map { ["id": $0, "type": "songs"] }, "meta": ["total": actual.count]])
            status = 200
        }
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@main struct WebMusicPaginationChecks {
    static var assertions = 0
    static func expect(_ value: Bool, _ message: String) throws {
        assertions += 1
        if !value { throw NSError(domain: message, code: 1) }
    }
    static let storefront: [String: Any] = ["data": [["id": "au", "type": "storefronts"]]]
    static let generation = "11111111-1111-4111-8111-111111111111"
    static func request(_ action: String) -> WebMusicRequest {
        switch action {
        case "catalogArtists": return WebMusicRequest(action: action, generation: generation, country: "AU", term: "Synthetic")
        case "catalogReleases": return WebMusicRequest(action: action, generation: generation, country: "AU", artistId: "42")
        default: return WebMusicRequest(action: action, generation: generation, country: "AU", releaseId: "70")
        }
    }
    static func main() async throws {
        let credentials = try WebCredentials.parse(bearer: "synthetic-bearer", user: "synthetic-user")
        let record = WebCredentialRecord(credentials: credentials, generation: generation)
        let owners: [String: Any] = ["artists": ["data": [["id": "42", "type": "artists"]], "meta": ["total": 1]]]
        let artist: [String: Any] = ["id": "42", "type": "artists", "attributes": ["name": "Synthetic", "url": "https://music.apple.com/au/artist/42"]]
        let album: [String: Any] = ["id": "70", "type": "albums", "attributes": ["name": "Synthetic", "releaseDate": "2026-01-01", "trackCount": 1, "url": "https://music.apple.com/au/album/70"], "relationships": owners]
        let song: [String: Any] = ["id": "80", "type": "songs", "attributes": ["name": "Synthetic", "artistName": "Synthetic", "albumName": "Synthetic", "durationInMillis": 1000, "discNumber": 1, "trackNumber": 1, "url": "https://music.apple.com/au/song/80"], "relationships": owners]
        let invalidMetadata: [Any] = [
            ["total": true], ["total": false], ["total": 1.5], ["total": "1"], ["total": -1],
            ["total": NSNull()], ["total": 9_007_199_254_740_992 as Int64], NSNull(), true, "invalid", [1]
        ]
        for (action, row, path) in [
            ("catalogArtists", artist, "/v1/catalog/au/search"),
            ("catalogReleases", album, "/v1/catalog/au/artists/42/albums"),
            ("catalogTracks", song, "/v1/catalog/au/albums/70/tracks")
        ] {
            func check(_ page: [String: Any], rejects: Bool, offset: Int = 0) async throws {
                let lock = PaginationLock()
                let network = PaginationTransport([storefront, action == "catalogArtists" ? ["results": ["artists": page]] : page], lock: lock)
                let service = WebMusicService(store: try PaginationStore(record), lock: lock, transport: network)
                var operation = request(action)
                if action != "catalogArtists" { operation.offset = offset }
                var rejected = false
                do { _ = try await service.handle(operation) }
                catch let error as WebMusicError { rejected = error == .malformed }
                try expect(rejected == rejects, "\(action) total validation, offset \(offset): \(page)")
                try expect(network.writes == 0 && network.pages.isEmpty && !lock.held, "catalog checks stay read-only and release lock")
            }
            for meta in invalidMetadata { try await check(["data": [row], "meta": meta], rejects: true) }
            for meta: [String: Any] in [[:], ["unrelated": 1], ["total": 1]] { try await check(["data": [row], "meta": meta], rejects: false) }
            try await check(["data": [row]], rejects: false)
            try await check(["data": [row], "meta": ["total": 0]], rejects: true)
            try await check(["data": [row], "meta": ["total": 2]], rejects: true)
            try await check(["data": [], "meta": ["total": 0]], rejects: false)
            let next = path + "?offset=1&limit=25"
            try await check(["data": [row], "meta": ["total": 1], "next": next], rejects: true)
            try await check(["data": [row], "meta": ["total": 2], "next": next], rejects: false)
            try await check(["data": [row], "next": next], rejects: false)
            if action != "catalogArtists" {
                try await check(["data": [row], "meta": ["total": 2]], rejects: false, offset: 1)
                try await check(["data": [row], "meta": ["total": 1]], rejects: true, offset: 1)
                try await check(["data": [], "meta": ["total": 2]], rejects: false, offset: 2)
                try await check(["data": [], "meta": ["total": 1]], rejects: true, offset: 2)
                for meta in invalidMetadata + [["total": 2]] {
                    var bad = row
                    bad["relationships"] = ["artists": ["data": [["id": "42", "type": "artists"]], "meta": meta]]
                    try await check(["data": [bad]], rejects: true)
                }
                var filtered = row
                if action == "catalogTracks" { filtered = ["id": "81", "type": "music-videos"] }
                else { filtered["relationships"] = ["artists": ["data": [["id": "99", "type": "artists"]]]] }
                try await check(["data": [row, filtered], "meta": ["total": 2]], rejects: false)
            }
        }
        let append = WebMusicRequest(action: "addTrackToPlaylist", generation: generation, catalogIds: ["1", "2"], position: 1, playlistId: "p.synthetic")
        func page(_ ids: [String], meta: Any? = nil, next: Int? = nil) -> [String: Any] {
            var object: [String: Any] = ["data": ids.map { ["id": $0, "type": "songs"] }]
            if let meta { object["meta"] = meta }
            if let next { object["next"] = "/v1/me/library/playlists/p.synthetic/tracks?offset=\(next)&limit=100" }
            return object
        }
        func playlist(_ pages: [[String: Any]], rejects: Bool) async throws {
            let lock = PaginationLock()
            let transport = PaginationTransport(pages, lock: lock)
            let result = try await WebMusicService(store: PaginationStore(record), lock: lock, transport: transport).handle(append)
            try expect(result["kind"] as? String == (rejects ? "conflict" : "confirmed"), "playlist totals must establish complete contents")
            try expect(transport.writes == 0 && !lock.held, "read validation prevents duplicate writes and releases lock")
        }
        for meta in invalidMetadata { try await playlist([page(["1", "2"], meta: meta)], rejects: true) }
        for meta: [String: Any] in [[:], ["unrelated": 1], ["total": 2]] { try await playlist([page(["1", "2"], meta: meta)], rejects: false) }
        try await playlist([page(["1", "2"])], rejects: false)
        try await playlist([page(["1"], meta: ["total": 2])], rejects: true)
        try await playlist([page(["1", "2"], meta: ["total": 1])], rejects: true)
        try await playlist([page(["1", "2"], meta: ["total": 2], next: 2)], rejects: true)
        try await playlist([page(["1"], meta: ["total": 2], next: 1), page(["2"], meta: ["total": 2])], rejects: false)
        try await playlist([page(["1"], next: 1), page(["2"], meta: ["total": 2])], rejects: false)
        try await playlist([page(["1"], meta: ["total": 2], next: 1), page(["2"])], rejects: false)
        try await playlist([page(["1"], meta: ["total": 3], next: 1), page(["2"], meta: ["total": 2])], rejects: true)
        try await playlist([page(["1"], meta: ["total": 2], next: 1), page(["2"], meta: ["total": 3], next: 2)], rejects: true)
        try await playlist([page(["1"], meta: ["total": 3], next: 1), page(["2"])], rejects: true)
        try await playlist([page(["1"], meta: ["total": 2], next: 1), page([], meta: ["total": 2])], rejects: true)
        for hasTotal in [false, true] {
            let lock = PaginationLock()
            let transport = PaginationTransport([page(["1"], meta: hasTotal ? ["total": 1] : nil), page(["1", "2"], meta: hasTotal ? ["total": 2] : nil)], lock: lock)
            let result = try await WebMusicService(store: PaginationStore(record), lock: lock, transport: transport).handle(append)
            try expect(result["kind"] as? String == "confirmed" && result["alreadyPresent"] as? Bool == false && transport.writes == 1 && transport.pages.isEmpty && !lock.held, "complete reads allow one confirmed append with optional totals")
        }
        let emptyLock = PaginationLock()
        let emptyTransport = PaginationTransport([page([], meta: ["total": 0]), page(["1"], meta: ["total": 1])], lock: emptyLock)
        var firstAppend = append; firstAppend.position = 0
        let first = try await WebMusicService(store: PaginationStore(record), lock: emptyLock, transport: emptyTransport).handle(firstAppend)
        try expect(first["kind"] as? String == "confirmed" && emptyTransport.writes == 1 && emptyTransport.pages.isEmpty && !emptyLock.held, "zero is an honest empty playlist total")
        for truncateBefore in [true, false] {
            let lock = PaginationLock()
            let transport = TruncatedPlaylistTransport(truncateBefore: truncateBefore, lock: lock)
            let service = WebMusicService(store: try PaginationStore(record), lock: lock, transport: transport)
            let result = try await service.handle(append)
            try expect(result["kind"] as? String == "conflict", "truncated playlist cannot confirm success")
            try expect(transport.writes == (truncateBefore ? 0 : 1) && transport.actual == (truncateBefore ? ["1", "2"] : ["1", "2", "3"]), "pre-read blocks duplicate write; post-read keeps actual synthetic contents")
            var retry = append; retry.reconcileOnly = true
            let reconciled = try await service.handle(retry)
            try expect(reconciled["kind"] as? String == "uncertain" && transport.writes == (truncateBefore ? 0 : 1) && !lock.held, "incomplete reconciliation never writes or falsely confirms")
        }
        for meta: [String: Any]? in [nil, [:], ["total": 1]] {
            let lock = PaginationLock()
            var playable = page(["1"], meta: meta)
            playable["data"] = [["id": "1", "type": "songs", "attributes": ["playParams": ["id": "1", "kind": "song"]]]]
            let network = PaginationTransport([storefront, playable], lock: lock)
            let result = try await WebMusicService(store: PaginationStore(record), lock: lock, transport: network).handle(WebMusicRequest(action: "inspectTracks", generation: generation, catalogIds: ["1", "2", "3", "2"]))
            try expect(result["availableCatalogTracks"] as? Int == 1 && result["unavailableCatalogTracks"] as? Int == 3 && result["unavailableCatalogIds"] as? [String] == ["2", "3"], "honest missing IDs retain unavailable occurrence counts")
            try expect(network.writes == 0 && network.pages.isEmpty && !lock.held, "availability stays read-only")
        }
        for meta in invalidMetadata + [["total": 2], ["total": 0]] {
            let lock = PaginationLock(), pages = [storefront, page(["1"], meta: meta)]
            let network = PaginationTransport(pages, lock: lock)
            var rejected = false
            do { _ = try await WebMusicService(store: PaginationStore(record), lock: lock, transport: network).handle(WebMusicRequest(action: "inspectTracks", generation: generation, catalogIds: ["1", "2"])) }
            catch let error as WebMusicError { rejected = error == .malformed }
            try expect(rejected && network.writes == 0 && !lock.held, "availability rejects supplied contradictory metadata")
        }
        let unavailableLock = PaginationLock()
        let unavailableTransport = PaginationTransport([storefront, page([], meta: ["total": 0])], lock: unavailableLock)
        let unavailable = try await WebMusicService(store: PaginationStore(record), lock: unavailableLock, transport: unavailableTransport).handle(WebMusicRequest(action: "inspectTracks", generation: generation, catalogIds: ["1", "2", "2"]))
        try expect(unavailable["availableCatalogTracks"] as? Int == 0 && unavailable["unavailableCatalogTracks"] as? Int == 3 && unavailableTransport.writes == 0 && !unavailableLock.held, "zero returned rows can honestly mean every selected occurrence is unavailable")
        for meta in invalidMetadata + [["total": 1], ["total": 3]] {
            let lock = PaginationLock()
            let rows = ["1", "9"].map { id in
                ["id": id, "type": "songs", "attributes": ["playParams": ["id": id, "kind": "song"], "isrc": "USABC2600001", "name": "Synthetic", "artistName": "Synthetic", "albumName": "Synthetic", "durationInMillis": 1000]] as [String: Any]
            }
            let transport = PaginationTransport([page(["9", "2"], meta: ["total": 2]), storefront, ["data": rows, "meta": meta]], lock: lock)
            let result = try await WebMusicService(store: PaginationStore(record), lock: lock, transport: transport).handle(append)
            try expect(result["kind"] as? String == "conflict" && transport.writes == 0 && transport.pages.isEmpty && !lock.held, "substitution lookup cannot falsely confirm inconsistent catalog reads")
        }
        print("Web music pagination checks passed: \(assertions) assertions, synthetic storage and transport only")
    }
}
