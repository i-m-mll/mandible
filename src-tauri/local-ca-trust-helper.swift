import AppKit
import CryptoKit
import Foundation
import Security

// This process is launched only by the explicit desktop/terminal setup action.
// Security.framework, not Mandible, presents and handles any credential panel.
func fail(_ message: String) -> Never {
    fputs("Native macOS trust setup failed: \(message)\n", stderr)
    exit(1)
}

if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--result" {
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = CommandLine.arguments[2]
    alert.informativeText = CommandLine.arguments[3]
    alert.addButton(withTitle: "OK")
    alert.runModal()
    exit(0)
}

guard CommandLine.arguments.count == 3 else { fail("expected a certificate snapshot and pinned digest") }
let snapshot = CommandLine.arguments[1]
let expectedDigest = CommandLine.arguments[2]
guard expectedDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { fail("invalid pinned digest") }
let bytes: Data
do { bytes = try Data(contentsOf: URL(fileURLWithPath: snapshot)) }
catch { fail("cannot read pinned certificate snapshot: \(error)") }
let actualDigest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
guard actualDigest == expectedDigest else { fail("certificate snapshot differs from the pinned root") }
guard let pem = String(data: bytes, encoding: .utf8),
      let begin = pem.range(of: "-----BEGIN CERTIFICATE-----"),
      let end = pem.range(of: "-----END CERTIFICATE-----", range: begin.upperBound..<pem.endIndex),
      let der = Data(base64Encoded: String(pem[begin.upperBound..<end.lowerBound]), options: .ignoreUnknownCharacters),
      let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
    fail("pinned root is not a valid PEM certificate")
}

// A GUI-capable process is required for the system-owned per-user authorization.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.activate(ignoringOtherApps: true)

while true {
    let alert = NSAlert()
    alert.messageText = "Set up secure local connections for this Mac account?"
    alert.informativeText = "This is a one-time setup. macOS may ask you to authorize it. Mandible will not ask for your password."
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Details…")
    let response = alert.runModal()
    if response == .alertThirdButtonReturn {
        let details = NSAlert()
        details.messageText = "Secure local connections details"
        details.informativeText = "Mandible pins this installation's Caddy HTTPS root and signing key. macOS will store the certificate and a per-user SSL trust rule for this account, not a computer-wide administrator rule. The SSL rule is not limited to Mandible hostnames; keep the signing key private. Root SHA-256: \(expectedDigest). To remove this trust later, use this account's Keychain Access certificate settings."
        details.addButton(withTitle: "Back")
        details.runModal()
        continue
    }
    guard response == .alertSecondButtonReturn else { fail("setup canceled before any trust change") }
    break
}

let addQuery: [String: Any] = [
    kSecClass as String: kSecClassCertificate,
    kSecValueRef as String: certificate,
    kSecAttrLabel as String: "Mandible secure local connections"
]
let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
    fail("macOS did not add the pinned certificate to this account (OSStatus \(addStatus))")
}

let sslPolicy = SecPolicyCreateSSL(true, nil)
let trustRule: [String: Any] = [
    kSecTrustSettingsPolicy as String: sslPolicy,
    kSecTrustSettingsResult as String: NSNumber(value: SecTrustSettingsResult.trustRoot.rawValue)
]
let trustStatus = SecTrustSettingsSetTrustSettings(certificate, SecTrustSettingsDomain.user, [trustRule] as CFArray)
guard trustStatus == errSecSuccess else {
    fail("macOS did not approve HTTPS trust for this account (OSStatus \(trustStatus)); setup remains prepared")
}
