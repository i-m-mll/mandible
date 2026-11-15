import CryptoKit
import Foundation

/// OpenSSH wire framing for `ecdsa-sha2-nistp256` keys and `PROTOCOL.sshsig` signatures.
enum SSHSignature {
    static let keyType = "ecdsa-sha2-nistp256"
    static let hashAlgorithm = "sha512"

    static func publicKeyLine(_ key: P256.Signing.PublicKey) -> String {
        "\(keyType) \(publicKeyBlob(key).base64EncodedString())"
    }

    /// The bytes the private key signs for `message` in `namespace`.
    static func signedData(namespace: String, message: Data) -> Data {
        var data = Data("SSHSIG".utf8)
        data.append(string(Data(namespace.utf8)))
        data.append(string(Data()))
        data.append(string(Data(hashAlgorithm.utf8)))
        data.append(string(Data(SHA512.hash(data: message))))
        return data
    }

    static func armored(publicKey: P256.Signing.PublicKey, namespace: String, signature: P256.Signing.ECDSASignature) -> String {
        let raw = signature.rawRepresentation
        var ecdsa = mpint(raw.prefix(32))
        ecdsa.append(mpint(raw.suffix(32)))
        var signatureBlob = string(Data(keyType.utf8))
        signatureBlob.append(string(ecdsa))

        var blob = Data("SSHSIG".utf8)
        blob.append(contentsOf: [0, 0, 0, 1])
        blob.append(string(publicKeyBlob(publicKey)))
        blob.append(string(Data(namespace.utf8)))
        blob.append(string(Data()))
        blob.append(string(Data(hashAlgorithm.utf8)))
        blob.append(string(signatureBlob))

        let encoded = blob.base64EncodedString()
        var lines = ["-----BEGIN SSH SIGNATURE-----"]
        var index = encoded.startIndex
        while index < encoded.endIndex {
            let end = encoded.index(index, offsetBy: 70, limitedBy: encoded.endIndex) ?? encoded.endIndex
            lines.append(String(encoded[index..<end]))
            index = end
        }
        lines.append("-----END SSH SIGNATURE-----")
        return lines.joined(separator: "\n") + "\n"
    }

    private static func publicKeyBlob(_ key: P256.Signing.PublicKey) -> Data {
        var blob = string(Data(keyType.utf8))
        blob.append(string(Data("nistp256".utf8)))
        blob.append(string(key.x963Representation))
        return blob
    }

    private static func string(_ bytes: Data) -> Data {
        var length = UInt32(bytes.count).bigEndian
        var data = Data(bytes: &length, count: 4)
        data.append(bytes)
        return data
    }

    private static func mpint(_ magnitude: Data) -> Data {
        var bytes = Data(magnitude.drop(while: { $0 == 0 }))
        if let first = bytes.first, first & 0x80 != 0 { bytes.insert(0, at: 0) }
        return string(bytes)
    }
}
