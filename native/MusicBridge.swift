import Cocoa
import ApplicationServices
import Carbon

func fail(_ message: String) throws -> Never {
    throw NSError(domain: "MusicBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String) -> String {
    return attribute(element, name) as? String ?? ""
}

func visitDescendants(_ root: AXUIElement, deadline: Date? = nil, visitor: (AXUIElement) -> Bool) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited: [CFHashCode: [AXUIElement]] = [:]
    var cursor = 0
    while cursor < queue.count && cursor < 12000 && (deadline == nil || Date() < deadline!) {
        let (element, depth) = queue[cursor]
        cursor += 1
        let hash = CFHash(element)
        if visited[hash, default: []].contains(where: { CFEqual($0, element) }) { continue }
        visited[hash, default: []].append(element)
        if visitor(element) { return element }
        if depth < 35 {
            if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                queue.append(contentsOf: children.map { ($0, depth + 1) })
            }
            // Music exposes its main window here even when AXWindows and AXChildren omit it.
            if text(element, kAXRoleAttribute) == kAXApplicationRole {
                for name in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
                    if let window = attribute(element, name), CFGetTypeID(window) == AXUIElementGetTypeID() {
                        queue.append((window as! AXUIElement, depth + 1))
                    }
                }
            }
        }
    }
    return nil
}

func descendants(_ root: AXUIElement) -> [AXUIElement] {
    var result: [AXUIElement] = []
    _ = visitDescendants(root, visitor: { result.append($0); return false })
    return result
}

func label(_ element: AXUIElement) -> String {
    for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        let value = text(element, name)
        if !value.isEmpty { return value }
    }
    return ""
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
          dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: origin, size: dimensions)
}

func requireFrontmost(_ element: AXUIElement) throws {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          let front = NSWorkspace.shared.frontmostApplication,
          front.processIdentifier == pid, front.bundleIdentifier == "com.apple.Music" else {
        try fail("Music lost focus. Retry without switching apps.")
    }
}

func key(_ code: CGKeyCode, root: AXUIElement) throws {
    try requireFrontmost(root)
    var pid: pid_t = 0
    guard AXUIElementGetPid(root, &pid) == .success,
          let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        try fail("Music's keyboard event could not be created. No key was sent.")
    }
    // Avoid inheriting the user's modifier keys and direct input to the guarded Music process.
    down.flags = []
    up.flags = []
    down.postToPid(pid)
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    up.postToPid(pid)
}

func click(_ element: AXUIElement, right: Bool = false) throws {
    try requireFrontmost(element)
    guard let rectangle = frame(element) else { try fail("Music did not expose the selected control's position.") }
    let point = CGPoint(x: rectangle.midX, y: rectangle.midY)
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &hit) == .success,
          let hit = hit,
          descendants(element).contains(where: { CFEqual($0, hit) }) || descendants(hit).contains(where: { CFEqual($0, element) }) else {
        try fail("Music's selected control moved or is covered. No click was sent. Close dialogs and retry.")
    }
    try requireFrontmost(element)
    let button: CGMouseButton = right ? .right : .left
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
}

func press(_ element: AXUIElement) throws {
    try requireFrontmost(element)
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success { try click(element) }
}

func waitFor(_ root: AXUIElement, seconds: TimeInterval, within containerIdentifierPrefix: String? = nil, predicate: (AXUIElement) -> Bool) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        let searchRoot: AXUIElement?
        if let prefix = containerIdentifierPrefix {
            searchRoot = visitDescendants(root, deadline: deadline, visitor: { text($0, kAXIdentifierAttribute).hasPrefix(prefix) })
        } else { searchRoot = root }
        if let searchRoot = searchRoot, let match = visitDescendants(searchRoot, deadline: deadline, visitor: predicate) { return match }
        Thread.sleep(forTimeInterval: 0.25)
    } while Date() < deadline
    return nil
}

func automationPermission() -> String {
    var target = AEAddressDesc()
    let bytes = Array("com.apple.Music".utf8)
    let result = bytes.withUnsafeBytes { AECreateDesc(DescType(typeApplicationBundleID), $0.baseAddress, bytes.count, &target) }
    guard result == noErr else { return "unknown" }
    defer { AEDisposeDesc(&target) }
    let permission = AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
    if permission == noErr { return "granted" }
    if permission == OSStatus(errAEEventNotPermitted) { return "denied" }
    return "unknown"
}

func handle(_ input: [String: Any]) throws -> [String: Any] {
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").first
    let trusted = AXIsProcessTrusted()
    if input["action"] as? String == "status" {
        let automation = automationPermission()
        let message: String
        if running == nil { message = "Open Music and sign in to Apple Music before creating a playlist." }
        else if !trusted { message = "Allow the Music bridge in System Settings > Privacy & Security > Accessibility. Catalog additions need this permission." }
        else if automation == "denied" { message = "Allow this app to control Music in System Settings > Privacy & Security > Automation." }
        else { message = "Music is available. You need an Apple Music subscription to add catalog songs." }
        return ["platform": "darwin", "running": running != nil, "accessibility": trusted, "automation": automation, "message": message]
    }
    guard input["action"] as? String == "add" else { try fail("Unknown Music bridge action.") }
    guard trusted else { try fail("Allow the Music bridge in System Settings > Privacy & Security > Accessibility, then retry. This bridge cannot grant itself permission.") }
    guard let app = running else { try fail("Open Music and sign in to Apple Music before continuing.") }
    guard let catalogId = input["catalogId"] as? NSNumber, catalogId.int64Value > 0,
          let title = input["title"] as? String, !title.isEmpty, title.count <= 1000,
          let artist = input["artist"] as? String, !artist.isEmpty, artist.count <= 1000 else { try fail("Invalid catalog song.") }
    app.activate(options: [])
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    // Activation is asynchronous. Let the workspace update before sending any input.
    let activationDeadline = Date().addingTimeInterval(3)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier && Date() < activationDeadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    try requireFrontmost(root)
    guard let sidebar = waitFor(root, seconds: 5, predicate: { text($0, kAXIdentifierAttribute) == "sidebarScroller" }),
          let search = waitFor(sidebar, seconds: 5, predicate: { element in
        return text(element, kAXRoleAttribute) == kAXRowRole &&
            descendants(element).contains(where: { label($0) == "Search" })
    }) else { try fail("Music's Search control is unavailable. Close dialogs and open Search in Music, then retry.") }
    // The selectable sidebar row can be offscreen and has no AXPress action.
    // Selecting it directly opens Search without clicking a guessed position.
    try requireFrontmost(search)
    guard AXUIElementSetAttributeValue(search, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success else {
        try fail("Music's catalog Search row could not be selected. Open Search in Music, then retry.")
    }
    guard let field = waitFor(root, seconds: 5, predicate: { element in
        let role = text(element, kAXRoleAttribute)
        return text(element, kAXIdentifierAttribute) != "filterField" && text(element, "AXPlaceholderValue") == "Apple Music" &&
            (role == "AXSearchField" || text(element, kAXSubroleAttribute) == "AXSearchField" || role == kAXTextFieldRole)
    }) else { try fail("Music did not show the Apple Music search field.") }
    if let scope = waitFor(root, seconds: 5, predicate: { text($0, kAXRoleAttribute) == kAXRadioButtonRole && label($0) == "Apple Music" }) {
        try press(scope)
    } else { try fail("Select the Apple Music search scope in Music, then retry.") }
    try requireFrontmost(field)
    guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, "\(title) \(artist)" as CFString) == .success,
          AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
        try fail("Music's search field could not be updated.")
    }
    try key(36, root: root)
    let id = catalogId.stringValue
    let identifiers = ["Music.shelfItem.TrackLockup[id=\(id),parentId=track-section-song]", "Music.shelfItem.TopSearchLockup[id=\(id),parentId=top-search-section-top]"]
    guard let song = waitFor(root, seconds: 20, within: "Music.page[", predicate: { identifiers.contains(text($0, kAXIdentifierAttribute)) }) else {
        try fail("Music search did not expose catalog song \(id). No song was added. This version may be unavailable in your subscription catalog.")
    }
    // The exact catalog ID is the selection boundary. Never choose a similarly named result.
    func exactSong() throws -> AXUIElement {
        try requireFrontmost(root)
        guard let current = waitFor(root, seconds: 2, within: "Music.page[", predicate: { identifiers.contains(text($0, kAXIdentifierAttribute)) }) else {
            try fail("The exact catalog song is no longer visible. No song was added.")
        }
        return current
    }
    try requireFrontmost(song)
    // Music can open its tracking menu while the AX action reports cannotComplete.
    // Check the visible result before sending a fallback click that could close it.
    _ = AXUIElementPerformAction(try exactSong(), kAXShowMenuAction as CFString)
    func isContextMenu(_ element: AXUIElement) -> Bool {
        return text(element, kAXRoleAttribute) == kAXMenuRole && text(element, kAXIdentifierAttribute) == "ellipsis"
    }
    var menu = waitFor(root, seconds: 1, predicate: isContextMenu)
    if menu == nil {
        try click(try exactSong(), right: true)
        menu = waitFor(root, seconds: 2, predicate: isContextMenu)
    }
    guard menu != nil else { try fail("Music did not open the selected song's menu. No song was added.") }
    _ = try exactSong()
    guard let menu = waitFor(root, seconds: 1, predicate: isContextMenu) else { try fail("The song's menu closed before it could be used. No song was added.") }
    if let add = descendants(menu).first(where: { text($0, kAXRoleAttribute) == kAXMenuItemRole && label($0) == "Add to Library" }) {
        guard (attribute(add, kAXEnabledAttribute) as? Bool) != false else { try fail("Add to Library is disabled. Check your Apple Music subscription and sign-in.") }
        try press(add)
        return ["requested": true]
    }
    if descendants(menu).contains(where: { label($0) == "Remove from Library" || label($0) == "Delete from Library" }) {
        // Verification remains the caller's job even when Music reports a pre-existing item.
        try key(53, root: root)
        return ["requested": false]
    }
    try fail("The selected catalog song has no Add to Library action. No song was added.")
}

do {
    guard CommandLine.arguments.count == 2, let data = CommandLine.arguments[1].data(using: .utf8),
          let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("Expected one JSON request argument.") }
    let result = try handle(input)
    let output = try JSONSerialization.data(withJSONObject: ["ok": true, "result": result], options: [.sortedKeys])
    print(String(data: output, encoding: .utf8)!)
} catch {
    let output = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": error.localizedDescription], options: [.sortedKeys])
    print(String(data: output, encoding: .utf8)!)
}
