import Foundation

struct HistoryDate: Codable, Equatable {
    var kind: String
    var value: String
}
struct HistoryCoverage: Codable, Equatable {
    struct Missing: Codable, Equatable {
        var artist: Int
        var album: Int
        var genre: Int
        var date: Int
        var reportedDurationMs: Int
        var mediaDurationMs: Int
    }
    var inputRows: Int
    var acceptedRows: Int
    var rejectedRows: Int
    var missing: Missing
    var firstDate: HistoryDate?
    var lastDate: HistoryDate?
    var datedRows: Int
    var instantRows: Int
    var durationRows: Int
    var enrichedRows: Int
    var unmatchedRows: Int
    var availableFields: [String]
    var warnings: [String]
}
struct HistorySuggestion: Codable, Equatable {
    var artist: String
    var kind: String
    var basis: String
}
struct HistoryTotals: Codable, Equatable {
    var tracks: Int
    var artists: Int
    var albums: Int
    var libraryPlayCount: Double?
    var activityRecords: Double?
    var reportedDurationMs: Double?
    var skippedCount: Double?
    var favoriteTracks: Double?
}
struct HistorySourceSummary: Codable, Equatable, Identifiable {
    var id: String { source }
    var source: String
    var savedAt: String
    var profile: String?
    var metricLabel: String
    var totals: HistoryTotals
    var coverage: HistoryCoverage
    var suggestions: [HistorySuggestion]
    var trendsAvailable: Bool
}
struct HistoryRow: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var artist: String?
    var album: String?
    var albumArtist: String?
    var genre: String?
    var libraryPlayCount: Double?
    var activityRecords: Double?
    var reportedDurationMs: Double?
    var skippedCount: Double?
    var favoriteTracks: Double?
    var lastDate: HistoryDate?
}
struct HistoryPage: Codable, Equatable {
    var source: String
    var kind: String
    var offset: Int
    var limit: Int
    var total: Int
    var rows: [HistoryRow]
    var metricLabel: String
    var excludedRows: Int
    var timeZone: String?
}
struct HistoryResponse: Codable, Equatable {
    var sources: [HistorySourceSummary]
    var preferredSource: String?
    var page: HistoryPage?
}
struct HistoryPreview: Codable, Equatable {
    var token: String
    var expiresAt: String
    var profile: String
    var coverage: HistoryCoverage
    var replacesExport: Bool
}

extension HistoryDate {
    var displayText: String {
        if kind == "date" { return "\(value) · calendar date" }
        guard kind == "instant" else { return "\(value) · time zone unresolved" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = parser.date(from: value)
        parser.formatOptions = [.withInternetDateTime]
        guard let date = fractional ?? parser.date(from: value) else { return "Unavailable" }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium; formatter.timeStyle = .short
        formatter.timeZone = .current
        return "\(formatter.string(from: date)) · \(TimeZone.current.identifier)"
    }
}

extension HistoryRow {
    func rankingDetail(for kind: String) -> String? {
        kind == "albums" ? albumArtist ?? artist ?? "Unavailable" : nil
    }
    func metricText(for kind: String) -> String {
        let value: Double?
        switch kind {
        case "libraryPlayCount": value = libraryPlayCount
        case "activityRecords": value = activityRecords
        case "reportedDurationMs": value = reportedDurationMs
        case "skippedCount": value = skippedCount
        case "favoriteTracks": value = favoriteTracks
        default: value = nil
        }
        guard let value, value.isFinite else { return "Unavailable" }
        func number(_ value: Double) -> String { String(format: "%.0f", locale: Locale(identifier: "en_US_POSIX"), value) }
        guard kind == "reportedDurationMs" else { return number(value) }
        let seconds = floor(value / 1000)
        let remainder = seconds.truncatingRemainder(dividingBy: 3600)
        if seconds >= 3600 { return "\(number(floor(seconds / 3600))) h \(number(floor(remainder / 60))) min \(number(remainder.truncatingRemainder(dividingBy: 60))) s" }
        if seconds >= 60 { return "\(number(floor(seconds / 60))) min \(number(seconds.truncatingRemainder(dividingBy: 60))) s" }
        return "\(number(seconds)) s"
    }
}

extension HistorySourceSummary {
    var sourceLabel: String {
        source == "library" ? "Music library snapshot" : "Apple CSV · \(HistoryPreview.profileLabel(profile))"
    }
    var pageKinds: [String] {
        let rankings = ["artists", "albums", "tracks", "genres"]
        return source == "export" && profile != "recently-played" && trendsAvailable ? rankings + ["daily", "monthly", "hourly"] : rankings
    }
}

extension HistoryPreview {
    static func profileLabel(_ profile: String?) -> String {
        switch profile {
        case "play-activity": return "Play activity"
        case "daily-tracks": return "Daily tracks"
        case "recently-played": return "Recently played"
        default: return "Unknown profile"
        }
    }
}
