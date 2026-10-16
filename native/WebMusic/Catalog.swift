import Foundation
import CoreFoundation

extension WebMusicService {
    private func safeCatalogID(_ value: String?) -> Int? {
        guard let value, value.range(of: "^[1-9][0-9]{0,15}$", options: .regularExpression) != nil,
              let number = Int(value), number <= 9_007_199_254_740_991 else { return nil }
        return number
    }
    func validateCatalogRequest(_ request: WebMusicRequest) throws {
        let isCatalog = ["catalogArtists", "catalogReleases", "catalogTracks"].contains(request.action)
        guard isCatalog else {
            guard request.country == nil, request.term == nil, request.artistId == nil, request.releaseId == nil, request.offset == nil else { throw WebMusicError.invalidInput }
            return
        }
        guard request.generation != nil, ["AU", "US", "GB", "CA", "JP", "DE"].contains(request.country ?? ""), request.catalogIds == nil,
              request.position == nil, request.reconcileOnly == nil, request.playlistId == nil,
              request.name == nil, request.credentials == nil, request.jobId == nil, request.coverMode == nil else { throw WebMusicError.invalidInput }
        switch request.action {
        case "catalogArtists":
            guard let term = request.term, !term.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  term.utf16.count <= 120, !term.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  request.artistId == nil, request.releaseId == nil, request.offset == nil else { throw WebMusicError.invalidInput }
        case "catalogReleases":
            guard safeCatalogID(request.artistId) != nil, request.releaseId == nil, request.term == nil,
                  (0...10_000).contains(request.offset ?? 0) else { throw WebMusicError.invalidInput }
        default:
            guard safeCatalogID(request.releaseId) != nil, request.artistId == nil, request.term == nil,
                  (0...10_000).contains(request.offset ?? 0) else { throw WebMusicError.invalidInput }
        }
    }
    private func catalogText(_ value: Any?, maximum: Int = 4096) throws -> String {
        guard let text = value as? String, text.utf8.count <= maximum,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw WebMusicError.malformed }
        return text
    }
    private func catalogNumber(_ value: Any?, maximum: Int) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue > 0, number.doubleValue <= Double(maximum) else { throw WebMusicError.malformed }
        return number.intValue
    }
    private func catalogURL(_ value: Any?, artwork: Bool = false) throws -> String {
        let text = try catalogText(value, maximum: 4096)
        guard let url = URLComponents(string: text), url.scheme == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased(),
              artwork ? host.hasSuffix(".mzstatic.com") : ["music.apple.com", "itunes.apple.com"].contains(host) else { throw WebMusicError.malformed }
        return text
    }
    private func catalogResource(_ row: [String: Any], type: String) throws -> (Int, [String: Any]) {
        guard row["type"] as? String == type, let id = safeCatalogID(row["id"] as? String),
              let attributes = row["attributes"] as? [String: Any] else { throw WebMusicError.malformed }
        return (id, attributes)
    }
    private func catalogArtwork(_ attributes: [String: Any], into result: inout [String: Any]) throws {
        guard let value = attributes["artwork"] else { return }
        guard let artwork = value as? [String: Any], let template = artwork["url"] as? String else { throw WebMusicError.malformed }
        let url = template.replacingOccurrences(of: "{w}", with: "300").replacingOccurrences(of: "{h}", with: "300").replacingOccurrences(of: "{f}", with: "jpg")
        result["artworkUrl"] = try catalogURL(url, artwork: true)
    }
    private func catalogArtists(_ row: [String: Any]) throws -> [Int] {
        guard let relationship = (row["relationships"] as? [String: Any])?["artists"] as? [String: Any],
              relationship["next"] == nil, let artists = relationship["data"] as? [[String: Any]], !artists.isEmpty,
              artists.count <= 100 else { throw WebMusicError.malformed }
        return try artists.map {
            guard $0["type"] as? String == "artists", let id = safeCatalogID($0["id"] as? String) else { throw WebMusicError.malformed }
            return id
        }
    }
    private func catalogDate(_ value: Any?) throws -> String {
        guard let text = value as? String, text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { throw WebMusicError.catalogDate }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let date = formatter.date(from: text), formatter.string(from: date) == text else { throw WebMusicError.catalogDate }
        return text
    }
    private func catalogNext(_ value: Any?, path: String, offset: Int, count: Int, limit: Int) throws -> Int? {
        guard let value else { return nil }
        guard let next = value as? String, next.utf8.count <= 1024, count > 0,
              let url = URLComponents(string: next), url.path == path, url.fragment == nil, url.user == nil, url.password == nil,
              (url.scheme == nil && url.host == nil) || (url.scheme == "https" && ["amp-api.music.apple.com", "api.music.apple.com"].contains(url.host ?? "") && (url.port == nil || url.port == 443)),
              let query = url.queryItems, (1...3).contains(query.count), Set(query.map(\.name)).count == query.count,
              query.allSatisfy({ item in
                  if item.name == "include" { return item.value == "artists" }
                  guard let value = item.value, value.range(of: "^(0|[1-9][0-9]{0,4})$", options: .regularExpression) != nil, let number = Int(value) else { return false }
                  return item.name == "offset" ? number == offset + count && number <= 10_000 : item.name == "limit" && number > 0 && number <= limit
              }), let raw = query.first(where: { $0.name == "offset" })?.value, let nextOffset = Int(raw), nextOffset > offset else { throw WebMusicError.malformed }
        return nextOffset
    }
    func catalog(_ request: WebMusicRequest, credentials: WebCredentials) async throws -> [String: Any] {
        let storefront = try await storefront(credentials)
        guard storefront == request.country!.lowercased() else { throw WebMusicError.storefrontMismatch }
        var result: [String: Any] = ["generation": request.generation!, "storefront": storefront]
        if request.action == "catalogArtists" {
            let object = try await json(path: "/v1/catalog/\(storefront)/search", query: [URLQueryItem(name: "types", value: "artists"), URLQueryItem(name: "limit", value: "25"), URLQueryItem(name: "term", value: request.term!)], credentials: credentials)
            guard let results = object["results"] as? [String: Any] else { throw WebMusicError.malformed }
            // Search omits the artists key when there are no matches.
            if results["artists"] == nil { result["artists"] = [[String: Any]]() }
            else {
                guard let artists = results["artists"] as? [String: Any], let rows = artists["data"] as? [[String: Any]], rows.count <= 25 else { throw WebMusicError.malformed }
                result["artists"] = try rows.map { row in
                    let (id, attributes) = try catalogResource(row, type: "artists")
                    var artist: [String: Any] = ["id": id, "name": try catalogText(attributes["name"]), "url": try catalogURL(attributes["url"])]
                    try catalogArtwork(attributes, into: &artist)
                    return artist
                }
            }
        } else {
            let releases = request.action == "catalogReleases", offset = request.offset ?? 0, limit = releases ? 25 : 50
            let path = releases ? "/v1/catalog/\(storefront)/artists/\(request.artistId!)/albums" : "/v1/catalog/\(storefront)/albums/\(request.releaseId!)/tracks"
            let object = try await json(path: path, query: [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "include", value: "artists")], credentials: credentials)
            guard let rows = object["data"] as? [[String: Any]], rows.count <= limit else { throw WebMusicError.malformed }
            if let next = try catalogNext(object["next"], path: path, offset: offset, count: rows.count, limit: limit) { result["nextOffset"] = next }
            var resources: [[String: Any]] = [], skipped = 0
            for row in rows {
                if !releases && row["type"] as? String == "music-videos" {
                    guard safeCatalogID(row["id"] as? String) != nil else { throw WebMusicError.malformed }
                    skipped += 1; continue
                }
                let (id, attributes) = try catalogResource(row, type: releases ? "albums" : "songs")
                let artists = try catalogArtists(row)
                if releases && !artists.contains(safeCatalogID(request.artistId)!) { continue }
                var resource: [String: Any] = ["id": id, "url": try catalogURL(attributes["url"])]
                if releases {
                    resource["name"] = try catalogText(attributes["name"])
                    resource["releaseDate"] = try catalogDate(attributes["releaseDate"])
                    resource["trackCount"] = try catalogNumber(attributes["trackCount"], maximum: 10_000)
                } else {
                    resource["artistId"] = artists[0]
                    resource["title"] = try catalogText(attributes["name"])
                    resource["artist"] = try catalogText(attributes["artistName"])
                    resource["album"] = try catalogText(attributes["albumName"])
                    resource["durationMs"] = try catalogNumber(attributes["durationInMillis"], maximum: 86_400_000)
                    resource["discNumber"] = try catalogNumber(attributes["discNumber"], maximum: 1000)
                    resource["trackNumber"] = try catalogNumber(attributes["trackNumber"], maximum: 10_000)
                }
                try catalogArtwork(attributes, into: &resource)
                resources.append(resource)
            }
            result[releases ? "releases" : "tracks"] = resources
            if !releases { result["skippedMusicVideos"] = skipped }
        }
        guard try JSONSerialization.data(withJSONObject: result).count <= 120 * 1024 else { throw WebMusicError.malformed }
        return result
    }
}
