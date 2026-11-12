import Foundation

private final class DecimalPaginationStore: WebCredentialStorage {
    let bytes: Data
    init(_ record: WebCredentialRecord) throws { bytes = try JSONEncoder().encode(record) }
    func read() throws -> Data? { bytes }
    func save(_ data: Data) throws { preconditionFailure("Unexpected storage write") }
    func delete() throws { preconditionFailure("Unexpected storage delete") }
}
private final class DecimalPaginationLock: WebOperationLock {
    var held = false
    func acquire() throws { precondition(!held); held = true }
    func release() { precondition(held); held = false }
}
private final class DecimalPaginationTransport: WebTransport {
    let lock: DecimalPaginationLock
    let truncateBefore: Bool
    var actual: [String]
    var writes = 0
    init(lock: DecimalPaginationLock, truncateBefore: Bool) {
        self.lock = lock; self.truncateBefore = truncateBefore
        actual = truncateBefore ? ["1", "2"] : ["1"]
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        precondition(lock.held && request.url!.host == "amp-api.music.apple.com")
        precondition(request.url!.path == "/v1/me/library/playlists/p.review/tracks")
        if request.httpMethod == "POST" {
            writes += 1; precondition(writes == 1)
            actual.append("2")
            if !truncateBefore { actual.append("3") }
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!)
        }
        precondition(request.httpMethod == "GET")
        let truncated = truncateBefore || writes > 0
        let visible = truncated ? Array(actual.dropLast()) : actual
        let rows = try JSONSerialization.data(withJSONObject: visible.map { ["id": $0, "type": "songs"] })
        // Keep the wire decimal intact so JSONSerialization can preserve NSDecimalNumber precision.
        let total = truncated ? "\(visible.count).999999999999999999" : "\(actual.count)"
        let body = Data(("{\"data\":" + String(decoding: rows, as: UTF8.self) + ",\"meta\":{\"total\":" + total + "}}").utf8)
        return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@main struct WebMusicPaginationReviewChecks {
    static func main() async throws {
        let generation = "11111111-1111-4111-8111-111111111111"
        let record = WebCredentialRecord(credentials: try WebCredentials.parse(bearer: "synthetic", user: "synthetic"), generation: generation)
        var failures: [String] = [], assertions = 0
        func expect(_ condition: Bool, _ message: String) {
            assertions += 1
            if !condition { failures.append(message); print("FAIL: " + message) }
        }
        for truncateBefore in [true, false] {
            let lock = DecimalPaginationLock()
            let transport = DecimalPaginationTransport(lock: lock, truncateBefore: truncateBefore)
            let service = WebMusicService(store: try DecimalPaginationStore(record), lock: lock, transport: transport)
            var request = WebMusicRequest(action: "addTrackToPlaylist", generation: generation, catalogIds: ["1", "2"], position: 1, playlistId: "p.review")
            let result = try await service.handle(request)
            print("truncateBefore=\(truncateBefore) kind=\(result["kind"] ?? "missing") writes=\(transport.writes) actual=\(transport.actual)")
            expect(result["kind"] as? String == "conflict", "fractional total must not confirm append, truncateBefore=\(truncateBefore)")
            expect(transport.writes == (truncateBefore ? 0 : 1), "malformed pre-read must prevent POST")
            expect(transport.actual == (truncateBefore ? ["1", "2"] : ["1", "2", "3"]), "malformed pre-read must preserve synthetic contents")
            expect(!lock.held, "append releases operation lock")
            request.reconcileOnly = true
            let reconciled = try await service.handle(request)
            expect(reconciled["kind"] as? String == "uncertain", "fractional total must not confirm reconciliation")
            expect(transport.writes == (truncateBefore ? 0 : 1) && !lock.held, "reconciliation never writes and releases lock")
        }
        let lock = DecimalPaginationLock()
        let service = WebMusicService(store: try DecimalPaginationStore(record), lock: lock, transport: DecimalPaginationTransport(lock: lock, truncateBefore: true))
        for raw in ["1.0000000000000001", "1.999999999999999999", "2.0000000000000001", "2.999999999999999999", "9007199254740990.5", "9007199254740991.1"] {
            let number = NSDecimalNumber(string: raw)
            let object: [String: Any] = ["meta": ["total": number]]
            var rejected = false
            do { _ = try service.pageTotal(object, count: number.intValue) }
            catch let error as WebMusicError { rejected = error == .malformed }
            expect(rejected, "reject preserved fractional total " + raw)
        }
        for raw in ["0", "1", "1.0", "1e0", "1000", "9007199254740991"] {
            let object = try JSONSerialization.jsonObject(with: Data(("{\"meta\":{\"total\":" + raw + "}}").utf8)) as! [String: Any]
            let number = (object["meta"] as! [String: Any])["total"] as! NSNumber
            expect(try service.pageTotal(object, count: number.intValue) == number.intValue, "retain valid integer total " + raw)
        }
        print("Independent decimal pagination review: \(assertions) assertions, \(failures.count) failures")
        if !failures.isEmpty { exit(1) }
    }
}
