import Foundation

enum WrapperPolicy {
    // Apple Support 101555 and Apple's distributed MusicKit JS identify these hosts.
    static let hosts: Set<String> = ["music.apple.com", "authorize.music.apple.com", "idmsa.apple.com", "account.apple.com", "gsa.apple.com", "appleid.cdn-apple.com", "play.itunes.apple.com", "itunes.apple.com", "finance-app.itunes.apple.com"]
    static func navigation(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", let host = url.host, hosts.contains(host), url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return false }
        return true
    }
    static func music(_ url: URL?) -> Bool { navigation(url) && url?.host == "music.apple.com" }
    static func blankPopup(_ url: URL?, source: URL?, main: Bool, active: Bool) -> Bool { active && main && music(source) && url?.absoluteString == "about:blank" }
    static func cookie(_ cookies: [HTTPCookie]) -> String? {
        let values = Set(cookies.filter { $0.name == "media-user-token" && $0.isSecure && ["music.apple.com", ".music.apple.com"].contains($0.domain.lowercased()) && ($0.expiresDate == nil || $0.expiresDate! > Date()) }.map(\.value))
        // Ambiguous cookies must not select an arbitrary account session.
        return values.count == 1 ? values.first : nil
    }
}

struct WrapperPopupPolicy {
    private var initialBlank: Bool
    private var blankResponse = false
    init(initialBlank: Bool) { self.initialBlank = initialBlank }
    mutating func navigation(_ url: URL?, active: Bool) -> Bool {
        guard active else { return false }
        if initialBlank && url?.absoluteString == "about:blank" { initialBlank = false; blankResponse = true; return true }
        initialBlank = false; blankResponse = false
        return WrapperPolicy.navigation(url)
    }
    mutating func response(_ url: URL?, active: Bool) -> Bool {
        guard active else { return false }
        if blankResponse && url?.absoluteString == "about:blank" { blankResponse = false; return true }
        return WrapperPolicy.navigation(url)
    }
}

struct WrapperCaptureGate {
    private(set) var generation = UUID().uuidString
    private(set) var active = true
    mutating func navigate() { generation = UUID().uuidString }
    mutating func cancel() { active = false; generation = UUID().uuidString }
    func accepts(_ epoch: String, url: URL?) -> Bool { active && generation == epoch && WrapperPolicy.music(url) }
    func message(_ body: Any, epoch: String, url: URL?, main: Bool) -> Credentials? {
        guard main, accepts(epoch, url: url), let body = body as? [String: Any], Set(body.keys) == ["bearer", "user", "generation"], body["generation"] as? String == epoch, let bearer = body["bearer"] as? String, let user = body["user"] as? String else { return nil }
        return try? Credentials.parse(bearer: bearer, user: user)
    }
    func getter(_ body: Any, cookies: [HTTPCookie], epoch: String, url: URL?) -> Credentials? {
        guard accepts(epoch, url: url), let body = body as? [String: Any], Set(body.keys).isSubset(of: ["bearer", "user"]), let bearer = body["bearer"] as? String, bearer.utf8.count <= 16384 else { return nil }
        if let value = body["user"] { guard let user = value as? String, user.utf8.count <= 16384 else { return nil } }
        let user = (body["user"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? WrapperPolicy.cookie(cookies)
        guard let user else { return nil }
        return try? Credentials.parse(bearer: bearer, user: user)
    }
}
