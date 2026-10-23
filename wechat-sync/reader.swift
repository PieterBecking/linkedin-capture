// Native read-only WeChat UI adapter. Outputs JSON; never types or sends messages.
import AppKit
import ApplicationServices
import Security

struct ReaderError: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never {
    throw ReaderError(code: code, message: message)
}
func emit(_ value: Any) {
    if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(bytes)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func attr(_ el: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, key as CFString, &value) == .success ? value : nil
}
func string(_ el: AXUIElement, _ key: String) -> String { attr(el, key) as? String ?? "" }
func children(_ el: AXUIElement) -> [AXUIElement] { attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func identifier(_ el: AXUIElement) -> String { string(el, kAXIdentifierAttribute) }
func text(_ el: AXUIElement) -> String {
    let title = string(el, kAXTitleAttribute)
    return (title.isEmpty ? string(el, kAXValueAttribute) : title).trimmingCharacters(in: .whitespacesAndNewlines)
}
func walk(_ root: AXUIElement) -> [AXUIElement] {
    var out: [AXUIElement] = [], queue: [(AXUIElement, Int)] = [(root, 0)]
    var seen = Set<CFHashCode>()
    while let (el, depth) = queue.popLast(), out.count < 6000 {
        if depth > 30 || !seen.insert(CFHash(el)).inserted { continue }
        out.append(el)
        queue.append(contentsOf: children(el).reversed().map { ($0, depth + 1) })
    }
    return out
}
func bounds(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
          AXValueGetValue(s as! AXValue, .cgSize, &size), size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
}
func app() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat").first
}
func locked() -> Bool {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    return session["CGSSessionScreenIsLocked"] as? Bool == true
        || session["kCGSSessionOnConsoleKey"] as? Bool == false
}
func doctor() -> [String: Any] {
    let bundle = app()?.bundleURL ?? URL(fileURLWithPath: "/Applications/WeChat.app")
    return ["ok": AXIsProcessTrusted() && app() != nil && !locked(),
            "accessibility": AXIsProcessTrusted(), "wechat_running": app() != nil,
            "screen_locked": locked(),
            "idle_seconds": CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!),
            "wechat_version": Bundle(url: bundle)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"]
}
func requireApp() throws -> (NSRunningApplication, AXUIElement) {
    guard AXIsProcessTrusted() else { try fail("accessibility_required", "Enable Accessibility for the host application in System Settings.") }
    guard !locked() else { try fail("screen_locked", "Unlock the Mac before reading WeChat.") }
    guard let running = app() else { try fail("wechat_not_running", "Open WeChat and sign in.") }
    let root = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 3)
    return (running, root)
}
func chatRows(_ root: AXUIElement) -> [(String, AXUIElement)] {
    walk(root).compactMap { el in
        let id = identifier(el)
        guard id.hasPrefix("session_item_"), bounds(el) != nil else { return nil }
        return (String(id.dropFirst("session_item_".count)), el)
    }
}
func currentTitle(_ root: AXUIElement) -> String {
    walk(root).first(where: { identifier($0) == "big_title_line_h_view" }).map(text) ?? ""
}
func matchesTitle(_ actual: String, _ expected: String) -> Bool {
    actual == expected || actual.replacingOccurrences(of: #"\s*[（(]\d+[）)]$"#, with: "", options: .regularExpression) == expected
}
func verify(_ root: AXUIElement, _ chat: String) throws {
    guard !locked(), matchesTitle(currentTitle(root), chat) else {
        try fail("conversation_changed", "The selected conversation changed during capture; nothing was imported.")
    }
}
func messageList(_ root: AXUIElement) throws -> AXUIElement {
    guard let list = walk(root).first(where: { identifier($0) == "chat_message_list" }) else {
        try fail("message_list_missing", "WeChat's message list is unavailable. Check that you are signed in.")
    }
    return list
}
func click(_ el: AXUIElement, _ pid: pid_t) throws {
    if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return }
    guard let rect = bounds(el) else { try fail("chat_unavailable", "The selected chat is not visible.") }
    let p = CGPoint(x: rect.midX, y: rect.midY)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.postToPid(pid)
    }
}
func scroll(_ list: AXUIElement, _ pixels: Int32, _ pid: pid_t) throws {
    guard let rect = bounds(list), let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
          wheelCount: 1, wheel1: pixels, wheel2: 0, wheel3: 0) else {
        try fail("scroll_failed", "Could not scroll WeChat's message pane.")
    }
    e.location = CGPoint(x: rect.midX, y: rect.midY)
    e.postToPid(pid)
}
func rows(_ list: AXUIElement) -> [[String: Any]] {
    children(list).compactMap { el -> [String: Any]? in
        let id = identifier(el), value = text(el)
        guard id != "virtual_cell", !value.isEmpty, let rect = bounds(el) else { return nil }
        let isMessage = id == "chat_bubble_item_view"
        let timestamp = !isMessage && value.count < 40 && value.range(of: #"\d{1,2}[:：]\d{2}"#, options: .regularExpression) != nil
        return ["kind": isMessage ? "message" : timestamp ? "timestamp" : "system",
                "text": value, "sender": "unknown", "y": rect.minY]
    }.sorted { ($0["y"] as? Double ?? 0) < ($1["y"] as? Double ?? 0) }
}
func rowFingerprint(_ rows: [[String: Any]]) -> String {
    String(data: (try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? ""
}
func settledRows(_ list: AXUIElement) -> [[String: Any]] {
    var last = rows(list)
    var stable = 0
    for _ in 0..<20 {
        Thread.sleep(forTimeInterval: 0.1)
        let next = rows(list)
        stable = rowFingerprint(next) == rowFingerprint(last) ? stable + 1 : 0
        last = next
        if stable >= 3 { return last }
    }
    return last
}
func readChat(_ chat: String, _ maxPages: Int) throws -> [String: Any] {
    let (running, root) = try requireApp()
    let candidates = chatRows(root).filter { $0.0 == chat }
    guard candidates.count == 1 else {
        try fail("chat_not_unique", "Pin this supplier chat in WeChat and give it a unique remark name; exactly one visible match is required.")
    }
    let previous = NSWorkspace.shared.frontmostApplication
    running.activate(options: [])
    defer {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier {
            previous?.activate(options: [])
        }
    }
    try click(candidates[0].1, running.processIdentifier)
    for _ in 0..<30 {
        if matchesTitle(currentTitle(root), chat) { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    try verify(root, chat)
    let list = try messageList(root)
    try scroll(list, -100000, running.processIdentifier)
    var page = settledRows(list)
    guard page.contains(where: { $0["kind"] as? String == "message" }) else {
        try fail("empty_conversation", "No readable messages were found in this conversation.")
    }
    let newest = page
    var pages = [page], reachedStart = false
    for _ in 1..<maxPages {
        try verify(root, chat)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier else {
            try fail("user_interrupted", "Capture stopped because the foreground application changed.")
        }
        let step = Int32((bounds(list)?.height ?? 400) * 0.55)
        try scroll(list, step, running.processIdentifier)
        var older = settledRows(list)
        if rowFingerprint(older) == rowFingerprint(page) {
            // Give asynchronously loaded history a second chance before declaring its start.
            Thread.sleep(forTimeInterval: 0.8)
            try scroll(list, step, running.processIdentifier)
            older = settledRows(list)
            if rowFingerprint(older) == rowFingerprint(page) { reachedStart = true; break }
        }
        pages.append(older)
        page = older
    }
    try verify(root, chat)
    try scroll(list, -100000, running.processIdentifier)
    let final = settledRows(list)
    guard rowFingerprint(final) == rowFingerprint(newest) else {
        try fail("new_messages_during_capture", "New messages or layout changes arrived during capture. Retry on the next run.")
    }
    try verify(root, chat)
    return ["ok": true, "chat": chat, "pages": pages, "reached_start": reachedStart,
            "captured_at": ISO8601DateFormatter().string(from: Date()), "sender_attribution": "unavailable"]
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first ?? "doctor" {
    case "doctor": emit(doctor())
    case "request-access":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        emit(["ok": AXIsProcessTrustedWithOptions(options)])
    case "chats":
        let (_, root) = try requireApp()
        emit(["ok": true, "chats": chatRows(root).map { ["name": $0.0] }])
    case "read":
        guard args.count >= 2 else { try fail("usage", "read requires an exact chat name.") }
        emit(try readChat(args[1], min(100, max(2, args.count > 2 ? Int(args[2]) ?? 30 : 30))))
    case "token-set", "token-get":
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.servo7.wechat-brain", kSecAttrAccount as String: "brain-api"]
        if args[0] == "token-set" {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard !data.isEmpty else { try fail("empty_token", "Token is empty.") }
            var add = query
            add[kSecValueData as String] = data
            let status = SecItemAdd(add as CFDictionary, nil)
            let result = status == errSecDuplicateItem
                ? SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary) : status
            guard result == errSecSuccess else { try fail("keychain_error", "Could not save the Brain token (status \(result)).") }
            emit(["ok": true])
        } else {
            var get = query
            get[kSecReturnData as String] = true
            var result: CFTypeRef?
            guard SecItemCopyMatching(get as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
                try fail("token_missing", "Configure the Brain API token first.")
            }
            FileHandle.standardOutput.write(data)
        }
    default: try fail("usage", "Use doctor, chats, read, token-set, or token-get.")
    }
} catch let error as ReaderError {
    emit(["ok": false, "error": error.code, "message": error.message]); exit(1)
} catch {
    emit(["ok": false, "error": "reader_error", "message": String(describing: error)]); exit(1)
}
