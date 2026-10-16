import SwiftUI
import WebKit
import AppKit

/// Captures a complete pair in memory. The caller owns API validation and persistence.
@MainActor struct AppleMusicSignInSheet: View {
    @StateObject private var session: WrapperWebSession
    init(onCapture: @escaping (Credentials) -> Void, onCancel: @escaping () -> Void) {
        _session = StateObject(wrappedValue: WrapperWebSession(onCapture: onCapture, onCancel: onCancel))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect Apple Music").font(.title2)
            Text("Sign in on Apple's page and complete any verification yourself. This app will obtain your Apple Music session connection. Only a successful connection can be saved locally in this Mac's Keychain.").font(.callout)
            WrapperWebView(session: session)
            HStack {
                Text(session.status).font(.callout)
                Spacer()
                Button("Cancel") { session.cancel() }.keyboardShortcut(.cancelAction)
            }
        }.padding(20).frame(minWidth: 740, minHeight: 650)
            .onDisappear { session.stop() }
    }
}

@MainActor private struct WrapperWebView: NSViewRepresentable {
    let session: WrapperWebSession
    func makeNSView(context: Context) -> WKWebView { session.start() }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: ()) {
        view.stopLoading()
    }
}

@MainActor final class WrapperWebSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate {
    @Published var status = "Sign in to Apple Music, then open your Library."
    private var gate = WrapperCaptureGate()
    private var mainView: WKWebView?
    private var popups: [(NSWindow, WKWebView)] = []
    private var popupPolicies: [ObjectIdentifier: WrapperPopupPolicy] = [:]
    private var timer: Timer?
    private var getterPending = false
    private let onCapture: (Credentials) -> Void
    private let onCancel: () -> Void
    init(onCapture: @escaping (Credentials) -> Void, onCancel: @escaping () -> Void) {
        self.onCapture = onCapture; self.onCancel = onCancel
        super.init()
    }
    func start() -> WKWebView {
        if let mainView { return mainView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, contentWorld: .page, name: "wavelengthCapture")
        configuration.userContentController.addUserScript(WKUserScript(source: WrapperCapture.observer, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self; view.uiDelegate = self
        mainView = view
        view.load(URLRequest(url: URL(string: "https://music.apple.com")!))
        return view
    }
    func cancel() { guard gate.active else { return }; stop(); onCancel() }
    func stop() {
        gate.cancel(); timer?.invalidate(); timer = nil; getterPending = false
        if let view = mainView {
            if WrapperPolicy.music(view.url) { view.evaluateJavaScript("window.__wavelengthCapture?.stop()", completionHandler: nil) }
            view.stopLoading()
            view.configuration.userContentController.removeScriptMessageHandler(forName: "wavelengthCapture", contentWorld: .page)
            view.configuration.userContentController.removeAllUserScripts()
            view.navigationDelegate = nil; view.uiDelegate = nil
        }
        for (window, view) in popups { view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil; window.close() }
        popups.removeAll(); popupPolicies.removeAll(); mainView = nil
    }
    private func complete(_ credentials: Credentials) {
        guard gate.active else { return }
        stop(); onCapture(credentials)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed: Bool
        if webView === mainView {
            allowed = gate.active && (WrapperPolicy.navigation(navigationAction.request.url) || blankBootstrap(navigationAction, from: webView))
        } else {
            allowed = popupPolicies[ObjectIdentifier(webView)]?.navigation(navigationAction.request.url, active: gate.active) ?? false
        }
        if !allowed { status = "This sign-in requested an unsupported page. Cancel to reconnect another way." }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let allowed = webView === mainView ? gate.active && WrapperPolicy.navigation(navigationResponse.response.url) : popupPolicies[ObjectIdentifier(webView)]?.response(navigationResponse.response.url, active: gate.active) ?? false
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === mainView else { return }
        gate.navigate(); getterPending = false; timer?.invalidate(); timer = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === mainView, gate.active, WrapperPolicy.music(webView.url) else { return }
        poll()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }
    private func poll() {
        guard let view = mainView, gate.active, !getterPending, WrapperPolicy.music(view.url) else { return }
        getterPending = true
        let epoch = gate.generation
        view.evaluateJavaScript(WrapperCapture.getter, in: nil, in: .page) { [weak self, weak view] result in
            guard let self, let view, view === self.mainView, self.gate.accepts(epoch, url: view.url) else { return }
            self.getterPending = false
            let body: Any
            switch result { case .success(let value): body = value; case .failure: body = NSNull() }
            if let pair = self.gate.getter(body, cookies: [], epoch: epoch, url: view.url) { self.complete(pair); return }
            // Native-only cookie fallback. No cookie is passed back to the page.
            view.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self, weak view] cookies in
                guard let self, let view, view === self.mainView, self.gate.accepts(epoch, url: view.url) else { return }
                if let pair = self.gate.getter(body, cookies: cookies, epoch: epoch, url: view.url) { self.complete(pair); return }
                let encoded = String(data: try! JSONEncoder().encode(epoch), encoding: .utf8)!
                view.evaluateJavaScript("window.__wavelengthCapture?.start(\(encoded))", in: nil, in: .page) { _ in }
                self.status = "Open Library on Apple's page to finish connecting. If sign-in is blocked, cancel."
            }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === mainView, message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "https", message.frameInfo.securityOrigin.host == "music.apple.com", message.frameInfo.securityOrigin.port == 443 || message.frameInfo.securityOrigin.port == 0,
              let pair = gate.message(message.body, epoch: gate.generation, url: mainView?.url, main: true) else { return }
        complete(pair)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let initialBlank = blankBootstrap(navigationAction, from: webView)
        guard gate.active, webView === mainView, navigationAction.targetFrame == nil, WrapperPolicy.navigation(navigationAction.request.url) || initialBlank, let mainView, popups.count < 3 else { status = "Unsupported sign-in popup. Cancel to reconnect another way."; return nil }
        configuration.websiteDataStore = mainView.configuration.websiteDataStore
        // Authentication popups have no capture script or native credential bridge.
        configuration.userContentController = WKUserContentController()
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popupPolicies[ObjectIdentifier(popup)] = WrapperPopupPolicy(initialBlank: initialBlank)
        popup.navigationDelegate = self; popup.uiDelegate = self
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 760), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Apple Music sign-in"; window.isReleasedWhenClosed = false; window.contentView = popup; window.delegate = self
        window.center(); window.makeKeyAndOrderFront(nil); popups.append((window, popup))
        return popup
    }
    private func blankBootstrap(_ action: WKNavigationAction, from view: WKWebView) -> Bool {
        let origin = action.sourceFrame.securityOrigin
        return view === mainView && action.targetFrame == nil && action.sourceFrame.isMainFrame && origin.protocol == "https" && origin.host == "music.apple.com" && (origin.port == 0 || origin.port == 443) && WrapperPolicy.blankPopup(action.request.url, source: view.url, main: true, active: gate.active)
    }
    func webViewDidClose(_ webView: WKWebView) {
        guard let index = popups.firstIndex(where: { $0.1 === webView }) else { return }
        let (window, view) = popups.remove(at: index)
        popupPolicies.removeValue(forKey: ObjectIdentifier(view))
        view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil; window.close()
    }
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let index = popups.firstIndex(where: { $0.0 === window }) else { return }
        let (_, view) = popups.remove(at: index)
        popupPolicies.removeValue(forKey: ObjectIdentifier(view))
        view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil; window.delegate = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { status = "Apple's sign-in page could not load. Cancel and try again later." }
    }
    // No authentication-challenge override: WebKit keeps default TLS validation.
}
