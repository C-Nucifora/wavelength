import Foundation

// Fixtures replace only Apple's network boundary. No real credentials or Keychain items.
final class FixtureProtocol: URLProtocol {
    static var replies: [(Int, String)] = []
    static var requests: [URLRequest] = []
    static var failAt: Int?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var observed = request
        if observed.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count))
            }
            observed.httpBody = data
        }
        Self.requests.append(observed)
        if Self.requests.count == Self.failAt {
            client?.urlProtocol(self, didFailWithError: NSError(domain: "FAKE_SECRET_RAW_ERROR", code: 1)); return
        }
        guard !Self.replies.isEmpty else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: "Unexpected fixture request", code: 1)); return
        }
        let reply = Self.replies.removeFirst()
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: reply.0, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class FakeStorage: CredentialStorage {
    var value: Data?
    var fails = false
    func read() throws -> Data? { value }
    func save(_ data: Data) throws { if fails { throw ProbeError.storage }; value = data }
    func delete() throws { value = nil }
}
final class FakeJournal: AttemptStorage {
    var state = AttemptState()
    var fails = false
    func read() throws -> AttemptState { state }
    func save(_ state: AttemptState) throws { if fails { throw ProbeError.storage }; self.state = state }
}

struct CheckFailure: Error { let message: String }
func expect(_ value: Bool, _ message: String) throws { if !value { throw CheckFailure(message: message) } }
func client(_ replies: [(Int, String)] = [], failAt: Int? = nil) -> ProbeClient {
    FixtureProtocol.replies = replies; FixtureProtocol.requests = []; FixtureProtocol.failAt = failAt
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
    return ProbeClient(credentials: Credentials(bearer: "fake-bearer", user: "fake-user"), configuration: config, pollDelay: 0)
}
let first = TestSong(id: "111", title: "No Surprises", artist: "Radiohead")
let second = TestSong(id: "222", title: "Karma Police", artist: "Radiohead")
let connection = Connection(storefront: "au", songs: [first, second])
let created = #"{"data":[{"id":"p.test123","type":"library-playlists","attributes":{"name":"Test"}}]}"#
let ordered = #"{"data":[{"id":"i.one","type":"library-songs","attributes":{"name":"No Surprises","artistName":"Radiohead","playParams":{"id":"i.one","kind":"song","isLibrary":true,"catalogId":"111"}}},{"id":"i.two","type":"library-songs","attributes":{"name":"Karma Police","artistName":"Radiohead","playParams":{"id":"i.two","kind":"song","isLibrary":true,"catalogId":"222"}}}]}"#
let partial = #"{"data":[{"id":"i.one","type":"library-songs","attributes":{"playParams":{"catalogId":"111"}}}]}"#

@main struct ProbeChecks {
    @MainActor static func main() async {
        var failures = 0; var passed = 0
        func test(_ name: String, _ body: () async throws -> Void) async {
            do { try await body(); passed += 1; print("PASS \(name)") }
            catch { failures += 1; print("FAIL \(name)") }
        }
        await test("normalize pasted bearer and store without displaying secrets") {
            let credentials = try Credentials.parse(bearer: "  Bearer fake-bearer  ", user: " fake-user ")
            try expect(credentials.bearer == "fake-bearer" && credentials.user == "fake-user", "normalize")
            try expect(!String(describing: credentials).contains("fake-"), "redact")
            let storage = FakeStorage(); try storage.save(JSONEncoder().encode(credentials))
            let saved = try JSONDecoder().decode(Credentials.self, from: storage.read()!)
            try expect(saved.bearer == "fake-bearer", "save roundtrip"); try storage.delete(); try expect(try storage.read() == nil, "exact deletion")
        }
        await test("reject blank oversized and header-injection credentials") {
            for input in ["", "Bearer ", "a\nb", "\tfake-bearer", String(repeating: "a", count: 16_385)] {
                do { _ = try Credentials.parse(bearer: input, user: "fake-user"); throw CheckFailure(message: "accepted") }
                catch is ProbeError {}
            }
        }
        await test("authenticated fixed-host request") {
            let request = try client().request(path: "/v1/me/storefront")
            try expect(request.url?.absoluteString == "https://amp-api.music.apple.com/v1/me/storefront", "host")
            try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fake-bearer", "authorization")
            try expect(request.value(forHTTPHeaderField: "Media-User-Token") == "fake-user", "user")
            try expect(request.value(forHTTPHeaderField: "Origin") == "https://music.apple.com", "origin")
            try expect(!request.httpShouldHandleCookies, "cookies")
        }
        await test("host and redirect guards") {
            let api = client()
            for path in ["https://evil.example/", "//evil.example", "/v1/me/../x", "/v1/me/library/playlists/p.bad/extra"] {
                do { _ = try api.request(path: path); throw CheckFailure(message: "unsafe path") } catch is ProbeError {}
            }
            var redirected = true
            api.urlSession(URLSession.shared, task: URLSession.shared.dataTask(with: URL(string: "https://example.invalid")!), willPerformHTTPRedirection: HTTPURLResponse(url: URL(string: "https://amp-api.music.apple.com")!, statusCode: 302, httpVersion: nil, headerFields: nil)!, newRequest: URLRequest(url: URL(string: "https://evil.example")!)) { redirected = $0 != nil }
            try expect(!redirected, "redirect rejected")
        }
        await test("storefront and exact artist title catalog search") {
            let song1 = #"{"results":{"songs":{"data":[{"id":"999","type":"songs","attributes":{"name":"No Surprises","artistName":"Wrong Artist"}},{"id":"111","type":"songs","attributes":{"name":"No Surprises","artistName":"Radiohead"}}]}}}"#
            let song2 = #"{"results":{"songs":{"data":[{"id":"222","type":"songs","attributes":{"name":"Karma Police","artistName":"Radiohead"}}]}}}"#
            let api = client([(200, #"{"data":[{"id":"au","type":"storefronts"}]}"#), (200, song1), (200, song2)])
            let checked = try await api.check(); try expect(checked.storefront == "au" && checked.songs == [first, second], "exact match")
            try expect(FixtureProtocol.requests.allSatisfy { $0.httpMethod == "GET" }, "check read only")
        }
        for (code, classification) in [(401, ProbeError.rejected), (403, .rejected), (404, .missing), (429, .rateLimited), (500, .server), (302, .unsafeURL)] {
            await test("redact server errors HTTP \(code)") {
                do { _ = try await client([(code, "FAKE_SECRET_RAW_BODY")]).check(); throw CheckFailure(message: "accepted") }
                catch let error as ProbeError { try expect(error == classification && !error.localizedDescription.contains("FAKE_SECRET"), "safe classification") }
            }
        }
        await test("redact raw transport errors") {
            do { _ = try await client(failAt: 1).check(); throw CheckFailure(message: "accepted") }
            catch let error as ProbeError { try expect(error == .transport && !error.localizedDescription.contains("FAKE_SECRET"), "transport hidden") }
        }
        await test("malformed storefront and JSON rejected") {
            for body in ["not json", #"{"data":[]}"#, #"{"data":[{"id":"../../evil"}]}"#] {
                do { _ = try await client([(200, body)]).check(); throw CheckFailure(message: "accepted") } catch is ProbeError {}
            }
        }
        await test("create first catalog track append second verify catalog order") {
            let api = client([(201, created), (204, ""), (200, ordered)]); var known = ""
            let outcome = await api.create(connection) { known = $0 }
            try expect(outcome.confirmed && outcome.playlistID == "p.test123" && known == "p.test123", "verified outcome")
            let writes = FixtureProtocol.requests.filter { $0.httpMethod == "POST" }
            try expect(writes.count == 2, "only two writes")
            let create = try JSONSerialization.jsonObject(with: writes[0].httpBody!) as! [String: Any]
            let relations = create["relationships"] as! [String: Any]; let tracks = relations["tracks"] as! [String: Any]
            let data = tracks["data"] as! [[String: String]]
            try expect(data == [["id": "111", "type": "songs"]], "first payload")
            let attributes = create["attributes"] as! [String: String]
            try expect(attributes["name"]!.hasPrefix("Wavelength connection test "), "label")
            let append = try JSONSerialization.jsonObject(with: writes[1].httpBody!) as! [String: [[String: String]]]
            try expect(append["data"] == [["id": "222", "type": "songs"]], "second payload")
            try expect(writes[1].url?.path == "/v1/me/library/playlists/p.test123/tracks", "append route")
        }
        await test("create failure stops append and never retries POST") {
            let outcome = await client([(403, "secret")]).create(connection) { _ in }
            try expect(!outcome.confirmed && outcome.playlistID == nil && FixtureProtocol.requests.count == 1, "stop")
        }
        await test("malformed create reply is uncertain and stops append") {
            let outcome = await client([(201, #"{"data":[{"id":"../bad"}]}"#)]).create(connection) { _ in }
            try expect(!outcome.confirmed && outcome.playlistID == nil && FixtureProtocol.requests.count == 1, "malformed create")
        }
        await test("wrong create resource type blocks append") {
            let outcome = await client([(201, #"{"data":[{"id":"p.test123","type":"songs"}]}"#), (204, ""), (200, ordered)]).create(connection) { _ in }
            try expect(!outcome.confirmed && outcome.playlistID == nil && FixtureProtocol.requests.count == 1, "resource contract")
        }
        await test("wrong storefront resource type stops search") {
            do { _ = try await client([(200, #"{"data":[{"id":"au","type":"songs"}]}"#)]).check(); throw CheckFailure(message: "accepted") }
            catch let error as ProbeError { try expect(error == .malformed && FixtureProtocol.requests.count == 1, "stop search") }
        }
        await test("append transport ambiguity verifies without rePOST") {
            let outcome = await client([(201, created), (200, ordered)], failAt: 2).create(connection) { _ in }
            try expect(outcome.confirmed && outcome.playlistID == "p.test123", "readback resolves")
            try expect(FixtureProtocol.requests.filter { $0.httpMethod == "POST" }.count == 2, "no retry")
        }
        await test("204 append with partial tracks is not success and retains ID") {
            let outcome = await client([(201, created), (204, "")] + Array(repeating: (200, partial), count: 5)).create(connection) { _ in }
            try expect(!outcome.confirmed && outcome.playlistID == "p.test123", "partial outcome")
            try expect(FixtureProtocol.requests.count == 7, "bounded GET polling")
        }
        await test("visibility delay resolves via GET only") {
            let outcome = await client([(201, created), (204, ""), (200, partial), (200, ordered)]).create(connection) { _ in }
            try expect(outcome.confirmed && FixtureProtocol.requests.count == 4, "delayed visible")
        }
        await test("wrong order and unmapped library IDs never confirm") {
            let reversed = #"{"data":[{"id":"222","type":"songs"},{"id":"111","type":"songs"}]}"#
            let unmapped = #"{"data":[{"id":"i.one","type":"library-songs"},{"id":"i.two","type":"library-songs"}]}"#
            for body in [reversed, unmapped, #"{"data":[],"next":"https://evil.example"}"#, "not json"] {
                let outcome = await client([(201, created), (204, "")] + Array(repeating: (200, body), count: 5)).create(connection) { _ in }
                try expect(!outcome.confirmed && outcome.playlistID == "p.test123", "unverified")
            }
        }
        await test("invalid catalog IDs rejected before write") {
            let invalid = Connection(storefront: "au", songs: [TestSong(id: "i.library", title: "No Surprises", artist: "Radiohead"), second])
            let outcome = await client().create(invalid) { _ in }
            try expect(!outcome.confirmed && FixtureProtocol.requests.isEmpty, "no unsafe writes")
        }
        await test("save clears secure entry and invalidates checked connection") {
            let storage = FakeStorage(); let model = ProbeModel(storage: storage, journal: FakeJournal())
            model.bearerInput = "Bearer fake-bearer"; model.userInput = "fake-user"; model.connection = connection
            model.save()
            try expect(model.saved && model.bearerInput.isEmpty && model.userInput.isEmpty && model.connection == nil && storage.value != nil, "saved and cleared")
            try expect(!model.status.contains("fake-"), "status redacted")
        }
        await test("failed save retains entry and reports safe error") {
            let storage = FakeStorage(); storage.fails = true
            let model = ProbeModel(storage: storage, journal: FakeJournal())
            model.bearerInput = "fake-bearer"; model.userInput = "fake-user"; model.save()
            try expect(!model.saved && !model.bearerInput.isEmpty && !model.status.contains("fake-") && model.status != "Save your own web-session headers locally to begin.", "safe failure")
        }
        await test("delete connection preserves token-free attempt and playlist ID") {
            let storage = FakeStorage(); storage.value = Data("fake".utf8)
            let journal = FakeJournal(); journal.state = AttemptState(attempted: true, playlistID: "p.test123")
            let model = ProbeModel(storage: storage, journal: journal); model.deleteConnection()
            try expect(storage.value == nil && model.state.playlistID == "p.test123" && model.state.attempted, "preserve attempt")
        }
        await test("journal failure prevents create network request") {
            let storage = FakeStorage(); try storage.save(JSONEncoder().encode(Credentials(bearer: "fake-bearer", user: "fake-user")))
            let journal = FakeJournal(); journal.fails = true
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
            _ = client(); let model = ProbeModel(storage: storage, journal: journal, configuration: config)
            model.connection = connection; await model.create()
            try expect(FixtureProtocol.requests.isEmpty && model.status != "Save your own web-session headers locally to begin.", "no unjournaled POST")
        }
        await test("journal write failure identifies attempt storage rather than Keychain") {
            let storage = FakeStorage(); try storage.save(JSONEncoder().encode(Credentials(bearer: "fake-bearer", user: "fake-user")))
            let journal = FakeJournal(); journal.fails = true
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
            _ = client(); let model = ProbeModel(storage: storage, journal: journal, configuration: config)
            model.connection = connection; await model.create()
            try expect(model.status.lowercased().contains("attempt record") && !model.status.contains("Keychain"), "right storage diagnosis")
            try expect(FixtureProtocol.requests.isEmpty && !model.busy && !model.writing, "stopped safely")
        }
        await test("completed model persists ID and blocks a second write across restart") {
            let storage = FakeStorage(); try storage.save(JSONEncoder().encode(Credentials(bearer: "fake-bearer", user: "fake-user")))
            let journal = FakeJournal(); let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
            _ = client([(201, created), (204, ""), (200, ordered)])
            let model = ProbeModel(storage: storage, journal: journal, configuration: config)
            model.connection = connection; await model.create()
            try expect(journal.state.attempted && journal.state.playlistID == "p.test123" && !model.canCreate, "persist and lock")
            let restarted = ProbeModel(storage: storage, journal: journal, configuration: config); restarted.connection = connection
            await restarted.create(); try expect(FixtureProtocol.requests.count == 3 && !restarted.canCreate, "restart no repeat")
        }
        await test("uncommitted credential edits disable writes") {
            let storage = FakeStorage(); try storage.save(JSONEncoder().encode(Credentials(bearer: "fake-bearer", user: "fake-user")))
            let model = ProbeModel(storage: storage, journal: FakeJournal()); model.connection = connection
            try expect(model.canCreate, "checked connection can create")
            model.bearerInput = "replacement-unsaved"
            try expect(!model.canCreate, "save first")
        }
        await test("returned ID persistence failure stops append") {
            let outcome = await client([(201, created)]).create(connection) { _ in throw ProbeError.storage }
            try expect(outcome.playlistID == "p.test123" && !outcome.confirmed && FixtureProtocol.requests.count == 1, "stop append")
        }
        print("Probe checks: \(passed) passed, \(failures) failed; fixtures only")
        if failures > 0 { exit(1) }
    }
}
