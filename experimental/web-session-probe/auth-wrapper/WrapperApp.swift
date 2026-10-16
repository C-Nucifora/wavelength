import SwiftUI
import AppKit

@main struct WrapperApp: App {
    @StateObject private var model = WrapperModel(storage: WrapperKeychain())
    var body: some Scene {
        Window("Wavelength sign-in spike", id: "auth-wrapper") {
            VStack(alignment: .leading, spacing: 16) {
                Text("Apple Music sign-in test").font(.title2)
                Text("Experimental web-session connection. Sign in yourself on Apple's page. This test checks your storefront and two catalog matches, then lets you save the connection in a separate Keychain item. It makes no playlist changes.").fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button(model.saved ? "Reconnect" : "Connect Apple Music") { model.connect() }.disabled(model.busy)
                    Button("Check saved connection") { Task { await model.checkSaved() } }.disabled(model.busy || !model.saved)
                    Button("Save connection locally") { model.save() }.disabled(!model.canSave)
                }
                if let connection = model.connection {
                    Text("Storefront: \(connection.storefront.uppercased())")
                    ForEach(Array(connection.songs.enumerated()), id: \.offset) { index, song in Text("\(index + 1). \(song.artist) · \(song.title)") }
                }
                if model.busy {
                    HStack { ProgressView().controlSize(.small); Button("Cancel check") { model.cancel() } }
                }
                Text(model.status).fixedSize(horizontal: false, vertical: true)
                Button("Disconnect this test") { model.disconnect() }.disabled(!model.saved || model.busy)
                Text("The Apple Music web session can expire or stop working. Disconnect removes only this test's saved connection.").font(.caption).foregroundStyle(.secondary)
            }.padding(24).frame(width: 680)
                .sheet(isPresented: $model.showingSignIn) {
                    AppleMusicSignInSheet(onCapture: { pair in Task { await model.capture(pair) } }, onCancel: { model.cancel() })
                        .interactiveDismissDisabled()
                }
                .onDisappear { model.cancel() }
        }.windowResizability(.contentSize)
    }
}
