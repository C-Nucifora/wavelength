import SwiftUI
import AppKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?
    private var stopping = false
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        sender.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil)
        sender.activate(ignoringOtherApps: true)
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if stopping { return .terminateLater }
        if model?.activeJob == true {
            let alert = NSAlert()
            let covering = model?.job?.state == "complete" && (model?.job?.coverActive == true || model?.pendingMusicRequest == true || model?.musicWriteUnconfirmed == true)
            alert.messageText = covering ? "Quit during playlist cover work?" : "Quit during playlist creation?"
            alert.informativeText = covering ? "All songs are saved. The cover may already be attached in Music. Wavelength checks saved cover progress when it opens again." : "The current song may already have been added. Completed additions stay in Music. Saved unfinished work can be retried when Wavelength opens again."
            alert.addButton(withTitle: "Keep Wavelength open")
            alert.addButton(withTitle: "Quit")
            if alert.runModal() != .alertSecondButtonReturn { return .terminateCancel }
        }
        stopping = true
        Task { await model?.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}
@main struct WavelengthApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    var body: some Scene {
        Window("Wavelength", id: "main") {
            ContentView(model: model).onAppear { delegate.model = model }
        }.defaultSize(width: 1100, height: 780).windowResizability(.contentMinSize)
            .commands {
                CommandGroup(replacing: .newItem) {}
                CommandMenu("Playlist") {
                    Button("Preview playlist") { Task { await model.preview() } }.disabled(!model.canPreview).keyboardShortcut(.return, modifiers: .command)
                    Button("Check selection") { Task { await model.checkLibrary() } }.disabled(!model.canCheck)
                    Button("Create playlist") { Task { await model.create() } }.disabled(!model.canCreate).keyboardShortcut(.return, modifiers: [.command, .shift])
                }
            }
    }
}
