import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: " + name); exit(1) }
}

final class WrapperFakeStorage: CredentialStorage {
    var data: Data?
    var failSave = false
    func read() throws -> Data? { data }
    func save(_ data: Data) throws { if failSave { throw ProbeError.storage }; self.data = data }
    func delete() throws { data = nil }
}

final class WrapperFixtureProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        guard request.httpMethod == "GET", request.url?.host == "amp-api.music.apple.com" else {
            client?.urlProtocol(self, didFailWithError: ProbeError.unsafeURL); return
        }
        let body: String
        if request.url?.path == "/v1/me/storefront" {
            body = #"{"data":[{"id":"au","type":"storefronts"}]}"#
        } else if request.url?.path == "/v1/catalog/au/search" {
            body = #"{"results":{"songs":{"data":[{"id":"111","type":"songs","attributes":{"name":"No Surprises","artistName":"Radiohead"}},{"id":"222","type":"songs","attributes":{"name":"Karma Police","artistName":"Radiohead"}}]}}}"#
        } else { client?.urlProtocol(self, didFailWithError: ProbeError.unsafeURL); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct WrapperChecks {
    @MainActor static func main() async {
        let music = URL(string: "https://music.apple.com/au/library")!
        expect(WrapperPolicy.navigation(music), "Music page allowed")
        for value in ["http://music.apple.com", "https://music.apple.com.evil.test", "https://evil.test", "https://music.apple.com:444", "https://user@music.apple.com"] {
            expect(!WrapperPolicy.navigation(URL(string: value)), "Unsafe navigation rejected")
        }
        expect(WrapperPolicy.navigation(URL(string: "https://idmsa.apple.com/appleauth/auth")), "Apple login allowed")
        expect(!WrapperPolicy.music(URL(string: "https://idmsa.apple.com")), "Login has no capture")
        let blank = URL(string: "about:blank")!
        expect(WrapperPolicy.blankPopup(blank, source: music, main: true, active: true), "Trusted initial blank popup bootstrap")
        expect(!WrapperPolicy.blankPopup(blank, source: music, main: false, active: true), "Subframe cannot bootstrap blank popup")
        expect(!WrapperPolicy.blankPopup(blank, source: URL(string: "https://idmsa.apple.com"), main: true, active: true), "Login frame cannot bootstrap blank popup")
        expect(!WrapperPolicy.blankPopup(blank, source: music, main: true, active: false), "Cancelled attempt cannot bootstrap popup")
        var popup = WrapperPopupPolicy(initialBlank: true)
        expect(popup.navigation(blank, active: true), "Initial blank navigation allowed once")
        expect(popup.response(blank, active: true), "Initial blank document response allowed once")
        expect(!popup.navigation(blank, active: true), "Later blank navigation rejected")
        expect(!popup.response(blank, active: true), "Later blank response rejected")
        expect(popup.navigation(URL(string: "https://idmsa.apple.com/appleauth/auth"), active: true), "Popup HTTPS login navigation allowed")
        expect(!popup.navigation(music, active: false), "Late popup navigation after cancellation rejected")
        let selected = HTTPCookie(properties: [.name: "media-user-token", .value: "fixture-user", .domain: ".music.apple.com", .path: "/", .secure: "TRUE"])!
        let foreign = HTTPCookie(properties: [.name: "media-user-token", .value: "foreign", .domain: "evil.test", .path: "/", .secure: "TRUE"])!
        let insecure = HTTPCookie(properties: [.name: "media-user-token", .value: "insecure", .domain: "music.apple.com", .path: "/"])!
        expect(WrapperPolicy.cookie([foreign, insecure, selected]) == "fixture-user", "Only exact secure music cookie selected")
        var gate = WrapperCaptureGate()
        let epoch = gate.generation
        let pair: [String: Any] = ["bearer": "Bearer fixture-bearer", "user": "fixture-user", "generation": epoch]
        expect(gate.message(pair, epoch: epoch, url: music, main: true)?.bearer == "fixture-bearer", "Complete trusted bridge pair")
        expect(gate.message(pair, epoch: epoch, url: music, main: false) == nil, "Subframe bridge rejected")
        expect(gate.message(pair, epoch: epoch, url: URL(string: "https://idmsa.apple.com"), main: true) == nil, "Login bridge rejected")
        expect(gate.message(["bearer": "fixture", "generation": epoch], epoch: epoch, url: music, main: true) == nil, "Partial bridge rejected")
        expect(gate.message(["bearer": "fixture", "user": "user\nInjected: value", "generation": epoch], epoch: epoch, url: music, main: true) == nil, "Header injection rejected")
        expect(gate.message(["bearer": "fixture", "user": "user", "generation": "foreign"], epoch: epoch, url: music, main: true) == nil, "Wrong generation rejected")
        expect(gate.getter(["bearer": "fixture-bearer"], cookies: [selected], epoch: epoch, url: music)?.user == "fixture-user", "Native cookie completes getter pair")
        expect(gate.getter(["bearer": "fixture-bearer"], cookies: [foreign], epoch: epoch, url: music) == nil, "Foreign cookie cannot complete getter")
        expect(gate.getter(["bearer": "fixture-bearer", "user": ["unexpected"]], cookies: [selected], epoch: epoch, url: music) == nil, "Wrong getter user type rejected before cookie combine")
        expect(gate.getter(["bearer": String(repeating: "a", count: 16385)], cookies: [selected], epoch: epoch, url: music) == nil, "Oversized getter rejected")
        gate.navigate()
        expect(gate.message(pair, epoch: epoch, url: music, main: true) == nil, "Late navigation bridge rejected")
        expect(gate.getter(["bearer": "fixture"], cookies: [selected], epoch: epoch, url: music) == nil, "Late cookie callback rejected")
        gate.cancel()
        expect(!gate.accepts(gate.generation, url: music), "Cancelled attempt inactive")
        print("PASS: wrapper origin, pair, native-cookie and lifecycle checks")
        let store = WrapperFakeStorage()
        let model = WrapperModel(storage: store, validate: { _ in Connection(storefront: "au", songs: []) })
        let credentials = try! Credentials.parse(bearer: "fixture-bearer", user: "fixture-user")
        model.connect()
        await model.capture(credentials)
        expect(model.connection?.storefront == "au", "Captured pair checked before saving")
        expect(store.data == nil, "Capture does not silently save")
        model.save()
        expect(model.saved && store.data != nil, "Explicit validated save")
        let original = store.data
        store.failSave = true; model.connect(); await model.capture(credentials); model.save()
        expect(store.data == original && model.status == "The connection could not be saved in Keychain.", "Storage failure preserves previous pair")
        store.failSave = false
        model.connect(); model.cancel(); model.save()
        expect(store.data == original, "Cancel preserves prior saved connection")
        model.disconnect()
        expect(store.data == nil && !model.saved && model.connection == nil, "Disconnect clears only injected store")
        let late = WrapperModel(storage: store, validate: { _ in
            try? await Task.sleep(nanoseconds: 30_000_000)
            return Connection(storefront: "us", songs: [])
        })
        late.connect()
        let task = Task { await late.capture(credentials) }
        await Task.yield(); late.cancel(); await task.value
        late.save()
        expect(late.connection == nil && store.data == nil, "Late validation after cancel cannot save")
        print("PASS: read-only validation, explicit save, replacement cancel and disconnect")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [WrapperFixtureProtocol.self]
        let networkModel = WrapperModel(storage: store, validate: { try await ProbeClient(credentials: $0, configuration: config).check() })
        networkModel.connect(); await networkModel.capture(credentials)
        expect(networkModel.connection?.songs.map(\.id) == ["111", "222"], "Real client validates catalog fixtures")
        expect(WrapperFixtureProtocol.requests.count == 3 && WrapperFixtureProtocol.requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.host == "amp-api.music.apple.com" }, "Wrapper validation has only fixed-host GET requests")
        print("PASS: real native client through read-only network fixture")
    }
}
