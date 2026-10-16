import SwiftUI
import AppKit
import Charts
import UniformTypeIdentifiers

struct GetStartedView: View {
    @ObservedObject var model: AppModel
    private var source: HistorySourceSummary? { model.history?.sources.first { $0.source == model.historySource } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Start with what you listen to.").font(.system(size: 29, weight: .medium))
                Text("Read a Music library snapshot or review one Apple CSV. History stays on this Mac and gives you artist starting points.")
                    .foregroundStyle(Palette.muted)
                HistoryControls(model: model)
                if let source {
                    HistorySourceDetails(source: source)
                    Text("Artist starting points").font(.title3)
                    Text("Choose an artist to set the Discover seed. Preview is a separate action and uses online discovery services.").font(.caption).foregroundStyle(Palette.muted)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), alignment: .leading)], alignment: .leading, spacing: 12) {
                        ForEach(Array(source.suggestions.prefix(6).enumerated()), id: \.offset) { _, suggestion in
                            VStack(alignment: .leading, spacing: 9) {
                                Text(suggestion.kind == "older-favorite" ? "Older favourite" : "Top artist").font(.caption).foregroundStyle(Palette.iris)
                                Text(suggestion.artist).font(.headline)
                                Text(suggestion.basis).font(.caption).foregroundStyle(Palette.muted)
                                Button("Use \(suggestion.artist)") { model.requestHistorySeed(suggestion) }
                                    .disabled(model.building || model.activeJob).accessibilityLabel("Use \(suggestion.artist) as Discover seed")
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(16).background(Palette.panel)
                                .clipShape(RoundedRectangle(cornerRadius: 9))
                        }
                    }
                    if source.suggestions.isEmpty { Text("No artist suggestions are available from this source.").foregroundStyle(Palette.muted) }
                } else {
                    Text(model.history == nil ? "Saved history is not available yet. The local engine must be ready before reading or importing." : "No saved history. Choose a source above, or begin with your own genre or artist.")
                        .foregroundStyle(Palette.muted)
                }
                Button("Continue to Discover") { model.page = .discover }.buttonStyle(.borderedProminent)
            }.padding(30).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct HistoryControls: View {
    @ObservedObject var model: AppModel
    @State private var importing = false
    @State private var forgetting = false
    private var sources: [HistorySourceSummary] { model.history?.sources ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !sources.isEmpty {
                Picker("History source", selection: Binding(get: { model.historySource }, set: { source in if let source { model.selectHistorySource(source) } })) {
                    ForEach(sources) { source in Text(source.sourceLabel).tag(Optional(source.source)) }
                }.pickerStyle(.menu).accessibilityLabel("Listening history source")
            }
            HStack(spacing: 12) {
                Button(sources.contains { $0.source == "library" } ? "Refresh Music library" : "Read Music library") {
                    Task { await model.scanHistory() }
                }.disabled(!model.canScanHistory).accessibilityLabel("Read Music library snapshot without changing Music")
                Button(sources.contains { $0.source == "export" } ? "Replace Apple CSV" : "Import Apple CSV") { importing = true }
                    .disabled(!model.connected || model.historyOperation != .idle)
                    .accessibilityLabel("Review one Apple CSV for import")
                Spacer()
                Button("Forget history", role: .destructive) { forgetting = true }
                    .disabled(!model.connected || model.historyOperation == .forgetting)
                    .accessibilityLabel("Forget local listening history")
            }
            HistoryOperationStatus(model: model)
        }
        .sheet(isPresented: $importing, onDismiss: { model.dismissHistoryPreview() }) { HistoryImportSheet(model: model) }
        .confirmationDialog("Forget local history?", isPresented: $forgetting) {
            Button("Forget history", role: .destructive) { Task { await model.forgetHistory() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes local library and CSV history and cancels pending history work. Your Music library, playlists, drafts, jobs and artist assessments stay intact. It does not securely erase disk data or backups.")
        }
    }
}

private struct HistoryOperationStatus: View {
    @ObservedObject var model: AppModel
    private var status: String? {
        switch model.historyOperation {
        case .idle: return model.historyScanInFlight ? "Reading Music library…" : nil
        case .readingFile: return "Reading selected CSV…"
        case .parsing: return "Reviewing CSV format and rows…"
        case .scanning: return "Reading Music library…"
        case .importing: return "Saving reviewed CSV…"
        case .forgetting: return "Forgetting local history…"
        }
    }
    var body: some View {
        if let status { HStack { ProgressView().controlSize(.small); Text(status).font(.caption) }.accessibilityElement(children: .combine).accessibilityLabel(status) }
    }
}

private struct HistorySourceDetails: View {
    let source: HistorySourceSummary
    private var totalsRow: HistoryRow {
        HistoryRow(id: "totals", label: "Totals", artist: nil, album: nil, albumArtist: nil, genre: nil,
                   libraryPlayCount: source.totals.libraryPlayCount, activityRecords: source.totals.activityRecords,
                   reportedDurationMs: source.totals.reportedDurationMs, skippedCount: source.totals.skippedCount,
                   favoriteTracks: source.totals.favoriteTracks, lastDate: nil)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(source.sourceLabel).font(.headline)
            Text("\(source.source == "library" ? "Captured" : "Imported") \(HistoryDate(kind: "instant", value: source.savedAt).displayText)").font(.caption)
            Text("\(source.totals.tracks) tracks · \(source.totals.artists) artists · \(source.totals.albums) albums").font(.caption)
            if source.source == "library" {
                Text("Library play count: \(totalsRow.metricText(for: "libraryPlayCount")) · Skip count: \(totalsRow.metricText(for: "skippedCount")) · Favourites: \(totalsRow.metricText(for: "favoriteTracks"))").font(.caption)
                Text("Current library metadata and cumulative counts, including zero-play tracks. Last played is the latest supplied date. Counts cannot reconstruct listening dates or minutes.").font(.caption).foregroundStyle(Palette.muted)
            } else {
                Text("\(source.metricLabel): \(totalsRow.metricText(for: "activityRecords")) · Reported play duration: \(totalsRow.metricText(for: "reportedDurationMs"))").font(.caption)
                Text(source.profile == "recently-played" ? "Recently played records show last-seen tracks, not individual listening events. No timeline is available." : "Observed export records cover only the supplied file. Missing durations remain unavailable; track length is never counted as listening time.").font(.caption).foregroundStyle(Palette.muted)
            }
            HistoryCoverageView(coverage: source.coverage)
        }.textSelection(.enabled)
    }
}

private struct HistoryCoverageView: View {
    let coverage: HistoryCoverage
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(coverage.acceptedRows) accepted / \(coverage.inputRows) input rows · \(coverage.rejectedRows) rejected").font(.caption)
            Text("Available fields: \(coverage.availableFields.isEmpty ? "Unavailable" : coverage.availableFields.joined(separator: ", "))").font(.caption)
            Text("Missing fields: artist \(coverage.missing.artist), album \(coverage.missing.album), genre \(coverage.missing.genre), date \(coverage.missing.date), reported duration \(coverage.missing.reportedDurationMs), media duration \(coverage.missing.mediaDurationMs).").font(.caption)
            Text("First observed: \(coverage.firstDate?.displayText ?? "Unavailable")\nLast observed: \(coverage.lastDate?.displayText ?? "Unavailable")").font(.caption)
            Text("\(coverage.datedRows) dated rows, \(coverage.instantRows) resolved instants, \(coverage.durationRows) rows with reported duration. \(coverage.enrichedRows) exact library enrichments, \(coverage.unmatchedRows) unmatched rows. Genre uses supplied or exact-enriched metadata.").font(.caption)
            ForEach(Array(coverage.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(Palette.iris) }
        }.foregroundStyle(Palette.muted).textSelection(.enabled)
    }
}

struct HistoryImportSheet: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var replacing = false
    private var existing: HistorySourceSummary? { model.history?.sources.first { $0.source == "export" } }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Review Apple CSV").font(.title2)
            Text("Request your Apple Media Services data at privacy.apple.com, extract the downloaded archive, then select one CSV. Supported contracts are Play activity, Daily tracks and Recently played. Other headers or export versions may be unsupported.").font(.callout)
            Link("Open Apple's data and privacy site", destination: URL(string: "https://privacy.apple.com")!)
            Text("Preview does not save. Import saves the reviewed file. A Music library snapshot stays separate. Real Apple-export compatibility remains unverified until checked with a user export.").font(.caption).foregroundStyle(Palette.muted)
            HistoryFilePicker(model: model)
            HistoryOperationStatus(model: model)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let preview = model.historyPreview {
                        Text("Detected profile: \(HistoryPreview.profileLabel(preview.profile))").font(.headline)
                        HistoryCoverageView(coverage: preview.coverage)
                    } else { Text("Select a CSV to review its format and coverage.").foregroundStyle(Palette.muted) }
                    if let error = model.error { Text("Import error: \(error)").foregroundStyle(Palette.iris).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button("Cancel", role: .cancel) { model.dismissHistoryPreview(); dismiss() }.disabled(model.historyOperation == .importing)
                Spacer()
                Button("Import") {
                    if model.historyPreview?.replacesExport == true { replacing = true }
                    else { save(replace: false) }
                }.buttonStyle(.borderedProminent).disabled(model.historyPreview == nil || model.historyOperation != .idle || !model.connected)
                    .accessibilityLabel("Import reviewed CSV into local history")
            }
        }.padding(26).frame(width: 650, height: 580)
            .interactiveDismissDisabled(model.historyOperation == .importing)
            .confirmationDialog("Replace saved Apple CSV?", isPresented: $replacing) {
                Button("Replace and import", role: .destructive) { save(replace: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Replace \(existing?.sourceLabel ?? "saved Apple CSV"), imported \(existing.map { HistoryDate(kind: "instant", value: $0.savedAt).displayText } ?? "Unavailable"), with this reviewed file? The library snapshot stays separate.")
            }
    }
    private func save(replace: Bool) {
        Task { await model.importHistory(replace: replace); if model.historyPreview == nil { dismiss() } }
    }
}

struct HistoryFilePicker: View {
    @ObservedObject var model: AppModel
    var body: some View {
        Button("Choose one CSV…") {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = false; panel.canChooseFiles = true; panel.canChooseDirectories = false
            panel.allowedContentTypes = [.commaSeparatedText]; panel.allowsOtherFileTypes = false
            panel.canCreateDirectories = false
            panel.begin { result in
                guard result == .OK, let url = panel.url else { return }
                Task { await model.previewHistoryFile(url) }
            }
        }.disabled(!model.connected || model.historyOperation != .idle)
            .accessibilityLabel("Choose a single CSV file for preview")
    }
}

struct ListeningView: View {
    @ObservedObject var model: AppModel
    private var source: HistorySourceSummary? { model.history?.sources.first { $0.source == model.historySource } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Listening").font(.system(size: 29, weight: .medium))
            HistoryControls(model: model)
            if let source {
                ScrollView { HistorySourceDetails(source: source).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 200)
                Picker("Listening view", selection: Binding(get: { model.history?.page?.kind ?? "artists" }, set: { kind in Task { await model.loadHistory(kind: kind) } })) {
                    ForEach(source.pageKinds, id: \.self) { kind in Text(kind.capitalized).tag(kind) }
                }.pickerStyle(.segmented).accessibilityLabel("Listening table or chart")
                if let page = model.history?.page, source.pageKinds.contains(page.kind) {
                    HistoryPageView(page: page)
                    HStack {
                        Button("Previous") { Task { await model.loadHistory(kind: page.kind, offset: max(0, page.offset - 50)) } }.disabled(page.offset == 0)
                            .accessibilityLabel("Previous page of listening rows")
                        Text(page.rows.isEmpty ? "0 of \(page.total) rows" : "\(page.offset + 1)–\(page.offset + page.rows.count) of \(page.total) rows").font(.caption)
                        Button("Next") { Task { await model.loadHistory(kind: page.kind, offset: page.offset + 50) } }.disabled(page.offset + 50 >= page.total || page.offset + 50 > 100000)
                            .accessibilityLabel("Next page of listening rows")
                    }
                } else {
                    Text("Choose a ranking to load this source.").foregroundStyle(Palette.muted)
                    Spacer()
                }
            } else {
                Text("No history source is available. Read the library or import a reviewed CSV to see Listening tables.").foregroundStyle(Palette.muted)
                Spacer()
            }
        }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct HistoryPageView: View {
    let page: HistoryPage
    private var isTrend: Bool { ["daily", "monthly", "hourly"].contains(page.kind) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isTrend {
                Text("Current page's observed \(page.kind == "hourly" ? "hours" : "dates")").font(.headline)
                Chart(page.rows) { row in
                    if let value = row.activityRecords {
                        BarMark(x: .value("Date or hour", row.label), y: .value(page.metricLabel, value))
                            .foregroundStyle(Palette.iris)
                            .accessibilityLabel(row.label).accessibilityValue("\(page.metricLabel): \(row.metricText(for: "activityRecords"))")
                    }
                }.frame(height: 150).accessibilityLabel("\(page.metricLabel), current page. Time zone: \(page.timeZone ?? "Unavailable"). Equivalent data in the table below.")
            }
            Text("\(page.metricLabel). \(page.excludedRows) records excluded.\(isTrend ? " Time zone: \(page.timeZone ?? "Unavailable"). Date-only records keep their calendar date; hourly bins require resolved instants." : "")").font(.caption).foregroundStyle(Palette.muted)
            if isTrend { trendTable }
            else if page.kind == "tracks" { trackTable }
            else { rankingTable }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var metric: String { page.source == "library" ? "libraryPlayCount" : "activityRecords" }
    private func rankingLabel(_ row: HistoryRow) -> some View {
        VStack(alignment: .leading) {
            Text(row.label)
            if let detail = row.rankingDetail(for: page.kind) {
                Text(detail).font(.caption).foregroundStyle(Palette.muted)
            }
        }
    }
    @ViewBuilder private var rankingTable: some View {
        if page.source == "library" {
            Table(page.rows) {
                TableColumn(page.kind.capitalized) { row in rankingLabel(row) }
                TableColumn("Library play count") { row in Text(row.metricText(for: "libraryPlayCount")) }
                TableColumn("Last played") { row in Text(row.lastDate?.displayText ?? "Unavailable") }
                TableColumn("Skip count") { row in Text(row.metricText(for: "skippedCount")) }
                TableColumn("Favourites") { row in Text(row.metricText(for: "favoriteTracks")) }
            }.accessibilityLabel("\(page.kind.capitalized) ranking table, Library play count")
        } else {
            Table(page.rows) {
                TableColumn(page.kind.capitalized) { row in rankingLabel(row) }
                TableColumn(page.metricLabel) { row in Text(row.metricText(for: metric)) }
                TableColumn("Last seen") { row in Text(row.lastDate?.displayText ?? "Unavailable") }
                TableColumn("Reported play duration") { row in Text(row.metricText(for: "reportedDurationMs")) }
            }.accessibilityLabel("\(page.kind.capitalized) ranking table, \(page.metricLabel)")
        }
    }
    @ViewBuilder private var trackTable: some View {
        if page.source == "library" {
            Table(page.rows) {
                TableColumn("Track", value: \.label)
                TableColumn("Artist") { row in Text(row.artist ?? "Unavailable") }
                TableColumn("Album") { row in Text(row.album ?? "Unavailable") }
                TableColumn("Library play count") { row in Text(row.metricText(for: "libraryPlayCount")) }
                TableColumn("Last played") { row in Text(row.lastDate?.displayText ?? "Unavailable") }
                TableColumn("Skip count") { row in Text(row.metricText(for: "skippedCount")) }
                TableColumn("Favourite") { row in Text(row.favoriteTracks.map { $0 > 0 ? "Yes" : "No" } ?? "Unavailable") }
            }
            .accessibilityLabel("Track ranking table, Library play count")
        } else {
            Table(page.rows) {
                TableColumn("Track", value: \.label)
                TableColumn("Artist") { row in Text(row.artist ?? "Unavailable") }
                TableColumn("Album") { row in Text(row.album ?? "Unavailable") }
                TableColumn(page.metricLabel) { row in Text(row.metricText(for: metric)) }
                TableColumn("Last seen") { row in Text(row.lastDate?.displayText ?? "Unavailable") }
                TableColumn("Reported play duration") { row in Text(row.metricText(for: "reportedDurationMs")) }
            }.accessibilityLabel("Track ranking table, \(page.metricLabel)")
        }
    }
    private var trendTable: some View {
        Table(page.rows) {
            TableColumn("Date or hour", value: \.label)
            TableColumn(page.metricLabel) { row in Text(row.metricText(for: "activityRecords")) }
            TableColumn("Reported play duration") { row in Text(row.metricText(for: "reportedDurationMs")) }
        }.accessibilityLabel("Current page's observed dates or hours, \(page.metricLabel), time zone \(page.timeZone ?? "Unavailable")")
    }
}
