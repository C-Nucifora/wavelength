import SwiftUI
import AppKit

private struct Instrument: View {
    var size: CGFloat = 60
    var body: some View {
        ZStack {
            Circle().stroke(Palette.line, lineWidth: 1)
            Circle().stroke(Palette.line, lineWidth: 1).padding(size / 7)
            ForEach(0..<24) { tick in
                Rectangle().fill(tick == 2 ? Palette.iris : Palette.muted.opacity(0.5)).frame(width: 1, height: 5)
                    .offset(y: -size / 2 + 4).rotationEffect(.degrees(Double(tick) * 15))
            }
            Circle().fill(Palette.iris).frame(width: 4, height: 4)
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}
struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var review: DraftTrack?
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Instrument(size: 25)
                Text("Wavelength").font(.system(size: 14, weight: .semibold))
                Spacer()
                Circle().fill(model.connected ? Color.green.opacity(0.7) : Palette.muted).frame(width: 6, height: 6)
                Text(model.starting ? "Starting local engine" : model.connected ? "Local engine ready" : "Engine offline")
                    .font(.caption).foregroundStyle(Palette.muted)
                if !model.connected && !model.starting { Button("Retry startup") { model.start() } }
            }.padding(.horizontal, 24).frame(height: 48)
            Divider().overlay(Palette.line)
            HStack(spacing: 0) {
                Sidebar(model: model).frame(width: 288)
                Divider().overlay(Palette.line)
                switch model.page {
                case .getStarted: GetStartedView(model: model)
                case .discover: workspace
                case .listening: ListeningView(model: model)
                }
            }
            Divider().overlay(Palette.line)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: model.error == nil ? "info.circle" : "exclamationmark.triangle").foregroundStyle(Palette.iris)
                Text(model.error ?? model.message).font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                if model.error != nil { Button("Dismiss") { model.error = nil }.buttonStyle(.borderless) }
            }.padding(.horizontal, 22).padding(.vertical, 10).background(Palette.panel)
                .accessibilityElement(children: .combine).accessibilityLabel(model.error ?? model.message)
        }
        .background(Palette.background).foregroundStyle(Color(red: 0.929, green: 0.933, blue: 0.941))
        .tint(Palette.iris).preferredColorScheme(.dark)
        .frame(minWidth: 960, minHeight: 680)
        .sheet(item: $review) { track in ReviewSheet(model: model, track: track) }
        .confirmationDialog("Use this artist as your starting point?", isPresented: Binding(get: { model.pendingHistorySeed != nil }, set: { if !$0 { model.cancelHistorySeed() } })) {
            Button("Replace draft and use artist") { model.confirmHistorySeed() }.disabled(model.building || model.activeJob)
            Button("Cancel", role: .cancel) { model.cancelHistorySeed() }
        } message: {
            Text("Using \(model.pendingHistorySeed?.artist ?? "this artist") clears the current draft. You can review the seed in Discover before requesting a new preview.")
        }
        .task { model.start() }
    }
    private var workspace: some View {
        let tracks = model.visibleTracks
        return VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 7) {
                    Text("DISCOVER / REVIEW / CREATE").font(.system(size: 10, weight: .medium)).tracking(1.4).foregroundStyle(Palette.iris)
                    Text("Find your next playlist.").font(.system(size: 29, weight: .medium))
                    Text("Choose a starting point, then make the playlist yours.").font(.caption).foregroundStyle(Palette.muted)
                }
                Spacer()
                Instrument()
            }
            ConnectionPanel(model: model, connection: model.musicConnection)
            VStack(spacing: 0) {
                HStack {
                    TextField("Your playlist name", text: $model.name).textFieldStyle(.plain).font(.system(size: 17, weight: .medium))
                        .accessibilityLabel("Playlist name").disabled(model.draft == nil || model.activeJob)
                    Text("\(model.selected.count) selected / \(model.visibleTracks.count) songs").font(.caption).foregroundStyle(Palette.muted)
                }.padding(14)
                Divider().overlay(Palette.line)
                if let draft = model.draft, draft.status == "building" {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(draft.progress.message).font(.caption)
                        ProgressView(value: Double(draft.progress.done), total: Double(max(1, draft.progress.total))).accessibilityLabel("Preview progress")
                    }.padding(14)
                }
                ScrollView {
                    if model.visibleTracks.isEmpty {
                        VStack(spacing: 12) {
                            Instrument(size: 51)
                            Text(emptyTitle).font(.system(size: 16, weight: .medium))
                            Text(model.draft?.error ?? "Choose a genre or artist and preview the songs here.")
                                .font(.caption).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                        }.frame(maxWidth: .infinity).frame(minHeight: 200).padding(20)
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(tracks.enumerated()), id: \.element.id) { entry in
                                let track = entry.element
                                if model.draft?.request.mode == "discography" && (entry.offset == 0 || tracks[entry.offset - 1].releaseId != track.releaseId) {
                                    HStack {
                                        Text(track.album).font(.system(size: 13, weight: .semibold))
                                        Spacer()
                                        Text(String(track.releaseDate.prefix(10))).font(.caption.monospacedDigit()).foregroundStyle(Palette.muted)
                                    }.padding(.vertical, 12).accessibilityElement(children: .combine)
                                }
                                TrackRow(model: model, track: track, review: { review = track })
                                if track.id != tracks.last?.id { Divider().overlay(Palette.line) }
                            }
                        }.padding(.horizontal, 14)
                    }
                }.frame(minHeight: 160, maxHeight: .infinity)
            }.background(Palette.panel.opacity(0.7)).clipShape(RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Palette.line))
            if let draft = model.draft, !draft.warnings.isEmpty {
                DisclosureGroup("\(draft.warnings.count) discovery notes") {
                    ScrollView { VStack(alignment: .leading, spacing: 5) { ForEach(draft.warnings, id: \.self) { Text($0).font(.caption).textSelection(.enabled) } } }.frame(maxHeight: 100)
                }.font(.caption).foregroundStyle(Palette.muted)
            }
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    if let check = model.preflight {
                        Text("\(check.total) selected · \(check.availableCatalogTracks ?? check.total) available · \(check.unavailableCatalogTracks ?? 0) unavailable · \((check.storefront ?? "").uppercased())").font(.caption).foregroundStyle(Palette.iris)
                        Text("Catalog availability checked. Songs are verified in order after each addition.").font(.system(size: 10)).foregroundStyle(Palette.muted)
                    } else { Text("Check the Apple Music catalog before creating.").font(.caption).foregroundStyle(Palette.muted) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if model.canDeselectUnavailable { Button("Deselect unavailable") { model.deselectUnavailable() } }
                Button("Check selection") { Task { await model.checkLibrary() } }.disabled(!model.canCheck)
                Button("Create playlist") { Task { await model.create() } }.buttonStyle(.borderedProminent).disabled(!model.canCreate)
                    .keyboardShortcut(.return, modifiers: [.command, .shift])
            }
            if let job = model.job { JobPanel(model: model, job: job) }
        }.padding(.horizontal, 30).padding(.vertical, 24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var emptyTitle: String {
        switch model.draft?.status {
        case "building": return "Finding your next songs…"
        case "cancelled": return "Preview cancelled."
        case "failed": return "The preview could not finish."
        default: return "A starting point, a new direction."
        }
    }
}
private struct ConnectionPanel: View {
    @ObservedObject var model: AppModel
    @ObservedObject var connection: MusicConnection
    @State private var signingIn = false
    @State private var manualEntry = false
    var body: some View {
        DisclosureGroup("Apple Music connection") {
            VStack(alignment: .leading, spacing: 8) {
                Text(model.musicStatus?.message ?? "Connect here to create playlists directly. Music does not need to be open, and playlist creation needs no Accessibility permission.")
                Text("Experimental web-session connection. Apple can expire or change it. Session values stay local in Keychain; they are never sent to the discovery engine.")
                HStack {
                    Button("Sign in with Apple Music · experimental") { signingIn = true }.disabled(!model.canManageConnection)
                    Button("Check connection") { Task { await model.connectionAction("check") } }.disabled(!model.canManageConnection)
                    Button("Disconnect") { Task { await model.connectionAction("disconnect") } }.disabled(!model.canManageConnection || model.musicStatus?.generation == nil)
                    if connection.busy { ProgressView().controlSize(.small) }
                }
                Text("Sign-in opens Apple's page inside the app and captures only your Apple Music session. You enter passwords and verification codes yourself. Save below validates it before storing it.")
                Toggle("Manual session entry", isOn: $manualEntry).toggleStyle(.checkbox)
                if manualEntry || !connection.bearerInput.isEmpty || !connection.userInput.isEmpty {
                    SecureField("Authorization bearer token", text: $connection.bearerInput).textFieldStyle(.roundedBorder).disabled(!model.canManageConnection)
                    SecureField("Media-User-Token", text: $connection.userInput).textFieldStyle(.roundedBorder).disabled(!model.canManageConnection)
                    Button("Validate and save locally") { Task { await model.connectionAction("save") } }.disabled(!model.canManageConnection || connection.bearerInput.isEmpty || connection.userInput.isEmpty)
                }
                if let error = connection.error { Text(error).foregroundStyle(.orange) }
                Text("If Keychain asks for access, choose Always Allow to remember Wavelength. Check connection requests access; background work never opens a Keychain prompt.")
                Text("Local Music history scans still need Automation permission. They do not add songs.")
            }.font(.caption).foregroundStyle(Palette.muted).padding(.top, 5)
        }.font(.caption).foregroundStyle(Palette.muted)
            .sheet(isPresented: $signingIn) {
                AppleMusicSignInSheet(onCapture: { credentials in
                    guard model.canManageConnection else { signingIn = false; return }
                    connection.capture(credentials); manualEntry = true; signingIn = false
                }, onCancel: { signingIn = false })
            }
    }
}
private struct Sidebar: View {
    @ObservedObject var model: AppModel
    @FocusState private var seedFocused: Bool
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                VStack(spacing: 5) {
                    navigation("Get started", page: .getStarted, icon: "sparkle")
                    navigation("Discover", page: .discover, icon: "magnifyingglass")
                    navigation("Listening", page: .listening, icon: "chart.bar")
                }
                Divider().overlay(Palette.line)
                if model.page == .discover {
                Text("START SOMEWHERE").font(.system(size: 10)).tracking(1.4).foregroundStyle(Palette.muted)
                Picker("Seed type", selection: $model.settings.mode) { Text("Genre").tag("genre"); Text("Artist").tag("artist"); Text("Discography").tag("discography") }.pickerStyle(.menu)
                    .disabled(model.building || model.activeJob)
                VStack(alignment: .leading, spacing: 7) {
                    Text(model.settings.mode == "genre" ? "Genre" : "Artist").font(.caption).foregroundStyle(Palette.muted)
                    TextField(model.settings.mode == "genre" ? "Search genres" : "Enter an artist", text: $model.settings.seed)
                        .textFieldStyle(.roundedBorder).font(.system(size: 17)).focused($seedFocused).accessibilityLabel("Genre or artist seed")
                        .disabled(model.building || model.activeJob)
                    if model.settings.mode == "genre" && seedFocused && !model.settings.seed.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(model.suggestionNames) { genre in
                                Button(genre.name) { model.settings.seed = genre.name; seedFocused = false }.buttonStyle(.plain).font(.caption).foregroundStyle(Palette.iris)
                            }
                        }.accessibilityLabel("Genre suggestions")
                    }
                    Text(model.settings.mode == "genre" ? "Explore artists from Every Noise's genre map." : model.settings.mode == "discography" ? "Albums, EPs and singles, oldest first. Tracks stay in release order, including repeat songs." : "Find the seed and related artists using MusicBrainz and ListenBrainz.").font(.system(size: 11)).foregroundStyle(Palette.muted)
                    if let error = model.genreError, model.settings.mode == "genre" { Text("Suggestions unavailable. Enter a genre to try it. \(error)").font(.caption).foregroundStyle(Palette.muted) }
                    if model.settings.mode == "discography" {
                        Button("Find artist in Apple Music") { Task { await model.searchArtists() } }.disabled(!model.canSearchArtists)
                        ForEach(model.artistMatches) { artist in
                            HStack(alignment: .top, spacing: 6) {
                                Button { model.chooseArtist(artist) } label: {
                                    HStack(alignment: .top, spacing: 7) {
                                        Image(systemName: model.chosenArtist?.id == artist.id ? "largecircle.fill.circle" : "circle").foregroundStyle(Palette.iris)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(artist.name).font(.caption).multilineTextAlignment(.leading)
                                            Text("Apple artist \(String(artist.id))").font(.system(size: 10)).foregroundStyle(Palette.muted)
                                        }
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(.plain).disabled(!model.canSearchArtists).accessibilityLabel("Choose \(artist.name), Apple artist \(String(artist.id))")
                                if let url = URL(string: artist.url), url.scheme == "https", ["music.apple.com", "itunes.apple.com"].contains(url.host ?? "") {
                                    Link(destination: url) { Image(systemName: "arrow.up.right.square") }.help("View artist on Apple Music").accessibilityLabel("View Apple artist \(String(artist.id))")
                                }
                            }.padding(.vertical, 4)
                        }
                        if let artist = model.chosenArtist { Text("Selected: \(artist.name)").font(.caption).foregroundStyle(Palette.iris) }
                    }
                }
                Divider().overlay(Palette.line)
                if model.settings.mode != "discography" {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Playlist length").font(.caption).foregroundStyle(Palette.muted)
                    Stepper(value: $model.settings.count, in: 1...50) { Text("\(model.settings.count) songs") }.accessibilityLabel("Playlist length, \(model.settings.count) songs")
                    HStack { ForEach([15, 30, 50], id: \.self) { count in Button("\(count)") { model.settings.count = count }.buttonStyle(.bordered) } }
                }
                Picker("Song selection", selection: $model.settings.selection) {
                    Text("Essentials + recent").tag("mix"); Text("Essentials").tag("essentials"); Text("Recent releases").tag("recent")
                }.pickerStyle(.menu)
                Picker("Tracks per artist", selection: $model.settings.perArtist) { ForEach(1...3, id: \.self) { Text("\($0)").tag($0) } }.pickerStyle(.menu)
                } else {
                    Text("Complete discographies with up to 1,000 songs. Larger discographies stop with an error. Reissues keep Apple's listed release dates.").font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                Picker("Music store", selection: $model.settings.country) {
                    Text("Australia").tag("AU"); Text("United States").tag("US"); Text("United Kingdom").tag("GB")
                    Text("Canada").tag("CA"); Text("Japan").tag("JP"); Text("Germany").tag("DE")
                }.pickerStyle(.menu)
                    .disabled(model.building || model.activeJob)
                Divider().overlay(Palette.line)
                Toggle("Include AI artists", isOn: $model.includeAI).toggleStyle(.switch).font(.caption)
                    .disabled(model.activeJob)
                Text(model.includeAI ? "On. Artists recorded as AI may be included." : "Off. Known AI artists are excluded. Unknown provenance stays visible for review.").font(.system(size: 11)).foregroundStyle(Palette.muted)
                Button { Task { await model.preview() } } label: { Text("Preview playlist").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(!model.canPreview).keyboardShortcut(.return, modifiers: .command)
                if model.building { Button("Cancel preview") { Task { await model.cancelPreview() } }.disabled(model.busy).frame(maxWidth: .infinity) }
                if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Request in progress") }
                Text("Preview and check first. Only Create in Music changes your library.").font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
            }.padding(22)
        }.frame(maxHeight: .infinity).background(Palette.background)
    }
    private func navigation(_ label: String, page: AppPage, icon: String) -> some View {
        Button { model.page = page } label: {
            Label(label, systemImage: icon).frame(maxWidth: .infinity, alignment: .leading).padding(9)
                .background(model.page == page ? Palette.panel : Color.clear).clipShape(RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).accessibilityLabel("Navigate to \(label)")
            .accessibilityAddTraits(model.page == page ? .isSelected : [])
    }
}
private struct TrackRow: View {
    @ObservedObject var model: AppModel
    var track: DraftTrack
    var review: () -> Void
    var body: some View {
        HStack(spacing: 11) {
            Toggle("Select \(track.title) by \(track.artist)", isOn: Binding(get: { model.selected.contains(track.id) }, set: { model.setSelected(track.id, $0) }))
                .labelsHidden().toggleStyle(.checkbox).disabled(model.building || model.activeJob || (!model.includeAI && track.provenance.kind == "ai"))
            AsyncImage(url: artworkURL) { image in image.resizable().scaledToFill() } placeholder: {
                Image(systemName: "opticaldisc").foregroundStyle(Palette.muted).frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.line)
            }.frame(width: 38, height: 38).clipShape(RoundedRectangle(cornerRadius: 5)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(track.trackNumber.map { "\($0). \(track.title)" } ?? track.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                Text("\(track.artist) · \(track.album)").font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
                Text(track.source).font(.system(size: 10)).foregroundStyle(Palette.muted).lineLimit(1)
                if let disc = track.discNumber { Text("Disc \(disc)").font(.system(size: 10)).foregroundStyle(Palette.muted) }
                if let storefront = model.unavailableStorefront(for: track) {
                    Text("Unavailable in \(storefront)").font(.system(size: 11, weight: .medium)).foregroundStyle(.orange)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 3) {
                Text(track.match == "review" ? "Match needs review" : track.provenance.kind == "unknown" ? "Unknown provenance" : "\(track.provenance.kind == "ai" ? "AI" : "Human") · local assessment")
                    .font(.system(size: 10)).foregroundStyle(track.match == "review" ? Palette.iris : Palette.muted)
                Text(track.duration).font(.system(size: 10, design: .monospaced)).foregroundStyle(Palette.muted)
            }
            Button { review() } label: { Image(systemName: "info.circle") }.buttonStyle(.borderless).help("Review sources and artist provenance")
                .accessibilityLabel("Review \(track.title)")
            Button { model.remove(track.id) } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).disabled(model.building || model.activeJob)
                .help("Remove from this draft").accessibilityLabel("Remove \(track.title)")
        }.padding(.vertical, 10).opacity(model.selected.contains(track.id) ? 1 : 0.65)
    }
    private var artworkURL: URL? {
        guard let value = track.artworkUrl, let url = URL(string: value), url.scheme == "https", let host = url.host, host.hasSuffix(".mzstatic.com") else { return nil }
        return url
    }
}
private struct ReviewSheet: View {
    @ObservedObject var model: AppModel
    let track: DraftTrack
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "unknown"
    @State private var evidence = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Review sources").font(.title2)
            Text("\(track.title) · \(track.artist)").font(.headline).textSelection(.enabled)
            Text("\(track.album) · \(track.duration) · \(track.releaseDate.prefix(10))").font(.caption).foregroundStyle(Palette.muted)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(track.source).font(.callout).textSelection(.enabled)
                    if let link = safeLink(track.sourceUrl) { Link("Discovery source ↗", destination: link) }
                    if let link = safeLink(track.url) { Link("Apple catalog page ↗", destination: link) }
                    Text(track.match == "review" ? "The artist identity or song version needs review. This song starts unselected." : "The catalog metadata matched the source. Music still verifies the song before adding it.").font(.caption)
                    Divider()
                    Text("Saved evidence").font(.headline)
                    let current = model.draft?.tracks.first { $0.id == track.id }?.provenance ?? track.provenance
                    Text(current.evidence.isEmpty ? "No evidence saved. Unknown provenance does not mean human authorship." : current.evidence.joined(separator: "\n\n")).textSelection(.enabled)
                    if let note = current.note { Text(note).font(.caption).foregroundStyle(Palette.muted) }
                    Picker("Local artist classification", selection: $kind) {
                        Text("Unknown").tag("unknown"); Text("Human").tag("human"); Text("AI").tag("ai")
                    }.pickerStyle(.segmented)
                    Text("Evidence or source URL").font(.caption)
                    TextEditor(text: $evidence).frame(height: 95).font(.body).border(Palette.line).accessibilityLabel("Artist provenance evidence")
                    Text("\(evidence.count) / 2000 characters. This is your assessment, not independent verification.").font(.caption).foregroundStyle(Palette.muted)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(Palette.iris).textSelection(.enabled) }
            HStack {
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save assessment") {
                    Task { if await model.saveProvenance(track: track, kind: kind, evidence: evidence) { dismiss() } }
                }.buttonStyle(.borderedProminent).disabled(!model.connected || model.busy || model.building || model.activeJob || evidence.count > 2000)
                    .keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 580, height: 560).background(Palette.background).preferredColorScheme(.dark).tint(Palette.iris)
            .onAppear { kind = track.provenance.kind; evidence = track.provenance.evidence.joined(separator: "\n") }
    }
    private func safeLink(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), ["https", "http"].contains(url.scheme) else { return nil }
        return url
    }
}
private struct JobPanel: View {
    @ObservedObject var model: AppModel
    var job: MusicJob
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(job.name).font(.system(size: 14, weight: .medium))
                Spacer()
                Text("\(job.addedCount) / \(job.tracks.count) added · \(job.state)").font(.caption).foregroundStyle(Palette.muted)
            }
            Text(job.message).font(.caption).foregroundStyle(Palette.muted).textSelection(.enabled)
            if job.writer == nil { Text("Legacy Music-app job preserved. Its original retry method is unavailable in this build.").font(.caption).foregroundStyle(Palette.muted) }
            if job.songActive { ProgressView(value: Double(job.addedCount), total: Double(max(1, job.tracks.count))).accessibilityLabel("Playlist creation progress") }
            if let cover = job.cover {
                HStack(spacing: 10) {
                    if let thumbnail = model.coverThumbnail {
                        Image(nsImage: thumbnail).resizable().scaledToFit().frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 5)).accessibilityLabel("Generated playlist cover")
                    }
                    if job.coverActive { ProgressView().controlSize(.small).accessibilityLabel("Playlist cover in progress") }
                    Text(cover.message).font(.caption).foregroundStyle(Palette.muted).textSelection(.enabled)
                    if let action = job.coverAction {
                        Button(action == "cover-permission" ? "Allow Music Automation" : action == "cover-retry" ? "Retry cover" : "Check cover") { Task { await model.coverAction(action) } }
                            .disabled(model.busy || !model.connected || model.activeJob || model.historyScanInFlight || model.building)
                    }
                }
            }
            if job.tracks.contains(where: { $0.error != nil }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(job.tracks.filter { $0.error != nil }) { result in Text("\(result.track.title): \(result.error ?? "")").font(.caption).textSelection(.enabled) }
                    }
                }.frame(maxHeight: 65)
            }
            HStack {
                if job.songActive { Button("Cancel creation") { Task { await model.jobAction("cancel") } } }
                if job.retryable { Button(job.finishable ? "Finish playlist" : "Retry remaining songs") { Task { await model.jobAction("retry") } } }
                Spacer()
                if job.songActive { Text("Cancellation stops after the current song.").font(.system(size: 10)).foregroundStyle(Palette.muted) }
            }.disabled(model.busy || !model.connected)
        }.padding(14).background(Palette.panel).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
    }
}
