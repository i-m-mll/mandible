import CryptoKit
import Foundation

// Software-key stand-in for the enclave: prints the public key line, then one
// armored signature per message file argument, separated by NUL bytes.
let namespace = CommandLine.arguments[1]
let key = P256.Signing.PrivateKey()
var output = SSHSignature.publicKeyLine(key.publicKey)
for path in CommandLine.arguments.dropFirst(2) {
    let message = try! Data(contentsOf: URL(fileURLWithPath: path))
    let signature = try! key.signature(for: SSHSignature.signedData(namespace: namespace, message: message))
    output += "\0" + SSHSignature.armored(publicKey: key.publicKey, namespace: namespace, signature: signature)
}
FileHandle.standardOutput.write(Data(output.utf8))
