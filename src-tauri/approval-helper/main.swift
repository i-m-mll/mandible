import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum Outcome {
    case created(publicKey: String)
    case status([[String: String]])
    case signed(signature: String)
    case refused(Refusal)
    case failed(String)

    var json: [String: Any] {
        switch self {
        case .created(let publicKey): return ["result": "created", "public_key": publicKey]
        case .status(let keys): return ["result": "status", "keys": keys]
        case .signed(let signature): return ["result": "signed", "signature": signature]
        case .refused(let refusal): return ["result": refusal.rawValue]
        case .failed(let detail): return ["result": "failed", "detail": detail]
        }
    }
}

enum Refusal: String, Error {
    case cancelled
    case biometryUnavailable = "biometry_unavailable"
    case biometryLockedOut = "biometry_locked_out"
    case keyInvalidated = "key_invalidated"
    case keyMissing = "key_missing"
    case noInteractiveSession = "no_interactive_session"
}

struct Failure: Error { let detail: String }

enum Request {
    case create(key: String)
    case status(keys: [String])
    case sign(key: String, namespace: String, message: Data, reason: String)
}

struct KeyFile: Codable {
    let key: Data
    let publicKey: String

    enum CodingKeys: String, CodingKey {
        case key
        case publicKey = "public_key"
    }
}

func usage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("mandible-approval-helper: \(message)\n".utf8))
    exit(64)
}

func parseRequest(_ input: Data) -> Request {
    guard let object = try? JSONSerialization.jsonObject(with: input), let fields = object as? [String: Any] else {
        usage("request is not a JSON object")
    }
    func text(_ name: String) -> String {
        guard let value = fields[name] as? String, !value.isEmpty else { usage("\(name) must be a non-empty string") }
        return value
    }
    func path(_ value: String) -> String {
        guard value.hasPrefix("/") else { usage("key paths must be absolute") }
        return value
    }
    func only(_ names: Set<String>) {
        let extra = Set(fields.keys).subtracting(names)
        guard extra.isEmpty else { usage("unexpected fields: \(extra.sorted().joined(separator: ", "))") }
    }
    switch fields["op"] as? String {
    case "create":
        only(["op", "key"])
        return .create(key: path(text("key")))
    case "status":
        only(["op", "keys"])
        guard let keys = fields["keys"] as? [String] else { usage("keys must be an array of strings") }
        return .status(keys: keys.map(path))
    case "sign":
        only(["op", "key", "namespace", "message", "reason"])
        guard let message = Data(base64Encoded: text("message")) else { usage("message must be base64") }
        return .sign(key: path(text("key")), namespace: text("namespace"), message: message, reason: text("reason"))
    default:
        usage("op must be create, status, or sign")
    }
}

/// Maps a LocalAuthentication, Security, or CryptoKit error to the closed result set.
func classify(_ error: Error) -> Outcome {
    if let refusal = error as? Refusal { return .refused(refusal) }
    if let failure = error as? Failure { return .failed(failure.detail) }
    var chain: [NSError] = []
    var next: NSError? = error as NSError
    while let current = next {
        chain.append(current)
        next = current.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    for nsError in chain {
        if nsError.domain == LAErrorDomain {
            switch LAError.Code(rawValue: nsError.code) {
            case .userCancel, .systemCancel, .appCancel: return .refused(.cancelled)
            case .biometryLockout: return .refused(.biometryLockedOut)
            case .biometryNotAvailable, .biometryNotEnrolled, .biometryDisconnected: return .refused(.biometryUnavailable)
            case .notInteractive: return .refused(.noInteractiveSession)
            default: break
            }
        }
        if nsError.domain == NSOSStatusErrorDomain && OSStatus(nsError.code) == errSecUserCanceled { return .refused(.cancelled) }
    }
    return .failed(chain.map { "\($0.domain) \($0.code): \($0.localizedDescription)" }.joined(separator: " <- "))
}

func requireInteractiveSession() throws {
    var attributes = SessionAttributeBits()
    let status = SessionGetInfo(callerSecuritySession, nil, &attributes)
    guard status == errSessionSuccess else { throw Failure(detail: "SessionGetInfo failed with \(status)") }
    guard attributes.contains(.sessionHasGraphicAccess) else { throw Refusal.noInteractiveSession }
}

/// A new context, with no reuse window, that has checked biometry is usable now; the caller invalidates it.
func biometricContext() throws -> LAContext {
    try requireInteractiveSession()
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
        context.invalidate()
        throw error ?? Refusal.biometryUnavailable
    }
    return context
}

func readKeyFile(_ path: String) throws -> KeyFile {
    let data: Data
    do { data = try Data(contentsOf: URL(fileURLWithPath: path)) }
    catch CocoaError.fileReadNoSuchFile { throw Refusal.keyMissing }
    do { return try JSONDecoder().decode(KeyFile.self, from: data) }
    catch { throw Failure(detail: "key file is not a Mandible approval key: \(error)") }
}

func requireOwnerOnlyDirectory(of path: String) throws {
    let directory = (path as NSString).deletingLastPathComponent
    var info = stat()
    guard lstat(directory, &info) == 0 else { throw Failure(detail: "cannot stat key directory: \(String(cString: strerror(errno)))") }
    guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
        throw Failure(detail: "key directory must be a directory owned by the caller with no group or other access")
    }
}

/// Writes `data` at `path` with mode 0600, atomically, refusing to replace an existing file.
func writeExclusive(_ data: Data, to path: String) throws {
    let temporary = "\(path).\(getpid()).tmp"
    let descriptor = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard descriptor >= 0 else { throw Failure(detail: "cannot create key file: \(String(cString: strerror(errno)))") }
    defer { unlink(temporary) }
    let written = data.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
    let synced = fsync(descriptor)
    close(descriptor)
    guard written == data.count, synced == 0 else { throw Failure(detail: "cannot write key file") }
    guard link(temporary, path) == 0 else {
        throw Failure(detail: errno == EEXIST ? "key file already exists" : "cannot place key file: \(String(cString: strerror(errno)))")
    }
}

func create(key path: String) throws -> Outcome {
    try requireOwnerOnlyDirectory(of: path)
    guard SecureEnclave.isAvailable else { throw Failure(detail: "this Mac has no Secure Enclave") }
    try biometricContext().invalidate()
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                       [.privateKeyUsage, .biometryCurrentSet], &error) else {
        throw error!.takeRetainedValue() as Error
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    let publicKey = SSHSignature.publicKeyLine(key.publicKey)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try writeExclusive(try encoder.encode(KeyFile(key: key.dataRepresentation, publicKey: publicKey)), to: path)
    return .created(publicKey: publicKey)
}

/// Asks the enclave to use the key while forbidding interaction: a usable key refuses only for lack of interaction.
func probe(_ file: KeyFile) throws {
    let context = try biometricContext()
    defer { context.invalidate() }
    context.interactionNotAllowed = true
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: file.key, authenticationContext: context)
        _ = try key.signature(for: Data())
        throw Failure(detail: "the enclave signed without authentication")
    } catch let error as NSError where error.domain == LAErrorDomain && error.code == LAError.notInteractive.rawValue {
        return
    }
}

func status(keys: [String]) -> Outcome {
    .status(keys.map { path in
        var entry = ["key": path]
        do {
            let file = try readKeyFile(path)
            entry["public_key"] = file.publicKey
            try probe(file)
            entry["state"] = "usable"
        } catch {
            switch classify(error) {
            case .refused(let refusal): entry["state"] = refusal.rawValue
            case .failed(let detail): entry["state"] = "failed"; entry["detail"] = detail
            default: preconditionFailure("classify returns only refusals and failures")
            }
        }
        return entry
    })
}

func sign(key path: String, namespace: String, message: Data, reason: String) throws -> Outcome {
    let file = try readKeyFile(path)
    let context = try biometricContext()
    defer { context.invalidate() }
    context.localizedReason = reason
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: file.key, authenticationContext: context)
    let signature = try key.signature(for: SSHSignature.signedData(namespace: namespace, message: message))
    return .signed(signature: SSHSignature.armored(publicKey: key.publicKey, namespace: namespace, signature: signature))
}

let request = parseRequest(FileHandle.standardInput.readDataToEndOfFile())
let outcome: Outcome
do {
    switch request {
    case .create(let key): outcome = try create(key: key)
    case .status(let keys): outcome = status(keys: keys)
    case .sign(let key, let namespace, let message, let reason): outcome = try sign(key: key, namespace: namespace, message: message, reason: reason)
    }
} catch {
    FileHandle.standardError.write(Data("mandible-approval-helper: \(error)\n".utf8))
    outcome = classify(error)
}
let output = try! JSONSerialization.data(withJSONObject: outcome.json, options: [.sortedKeys, .withoutEscapingSlashes])
FileHandle.standardOutput.write(output + Data("\n".utf8))
