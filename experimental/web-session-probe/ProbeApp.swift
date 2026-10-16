import SwiftUI
import AppKit

@MainActor final class ProbeDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    weak var model: ProbeModel?
    private var closingApproved = false
    private func confirmClose() -> Bool {
        guard model?.writing == true, !closingApproved else { return true }
        let alert = NSAlert()
        alert.messageText = "A playlist may already exist"
        alert.informativeText = "A write is in progress. Closing can lose a response or leave a partial playlist. The probe saved the attempt before sending it and keeps any returned playlist ID. Inspect Apple Music before any further test."
        alert.addButton(withTitle: "Keep open"); alert.addButton(withTitle: "Close probe")
        closingApproved = alert.runModal() == .alertSecondButtonReturn
        return closingApproved
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { confirmClose() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { confirmClose() ? .terminateNow : .terminateCancel }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct ProbeWindowHook: NSViewRepresentable {
    let delegate: ProbeDelegate
    final class View: NSView {
        weak var probeDelegate: ProbeDelegate?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); window?.delegate = probeDelegate }
    }
    func makeNSView(context: Context) -> View { let view = View(); view.probeDelegate = delegate; return view }
    func updateNSView(_ view: View, context: Context) { view.probeDelegate = delegate; view.window?.delegate = delegate }
}

@main struct WebSessionProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeDelegate.self) private var delegate
    @StateObject private var model = ProbeModel(storage: ProbeKeychain(), journal: ProbeJournal())
    var body: some Scene {
        Window("Wavelength web-session probe", id: "probe") {
            VStack(alignment: .leading, spacing: 14) {
                Text("Apple Music connection test").font(.title2.bold())
                Text("Experimental and unsupported. Web-session credentials can expire or stop working. This probe sends them only to Apple's amp-api.music.apple.com. It can create one test playlist in your own library.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Sign in manually at music.apple.com in Safari. Paste only your Authorization and Media-User-Token header values below. Treat both like passwords; never paste them into chat.")
                    .fixedSize(horizontal: false, vertical: true)
                SecureField("Authorization bearer token", text: $model.bearerInput)
                    .disabled(model.busy)
                SecureField("Media-User-Token", text: $model.userInput)
                    .disabled(model.busy)
                HStack {
                    Button("Save locally") { model.save() }
                        .disabled(model.busy || model.bearerInput.isEmpty || model.userInput.isEmpty)
                    Button("Check connection") { Task { await model.check() } }.disabled(model.busy || !model.saved)
                    Button("Delete saved connection") { model.deleteConnection() }.disabled(model.busy || !model.saved)
                }
                if let connection = model.connection {
                    Text("Storefront: \(connection.storefront.uppercased())")
                    ForEach(Array(connection.songs.enumerated()), id: \.offset) { index, song in
                        Text("\(index + 1). \(song.artist) · \(song.title) · catalog \(song.id)")
                    }
                }
                Button("Create test playlist") { Task { await model.create() } }
                    .disabled(!model.canCreate)
                Text("Creates a uniquely labelled 'Wavelength connection test' playlist with song 1, appends song 2, then reads back both catalog IDs in order. It never deletes playlists or retries writes.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if model.busy { ProgressView().controlSize(.small) }
                Text(model.status).fixedSize(horizontal: false, vertical: true)
                if let id = model.state.playlistID {
                    Text("Retained playlist ID: \(id)").textSelection(.enabled)
                }
                if model.state.attempted { Text("One write attempt per probe. Further writes are blocked, including after reopening.").font(.caption) }
            }
            .padding(24).frame(width: 610).textFieldStyle(.roundedBorder)
            .background(ProbeWindowHook(delegate: delegate).frame(width: 0, height: 0))
            .onAppear { delegate.model = model }
        }
        .windowResizability(.contentSize)
    }
}
