export function desktopImage(code = 7, signatureSize = 16, signatureByte = 1) {
  const signatureOffset = 136;
  const image = Buffer.alloc(signatureOffset + signatureSize);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(2, 16);
  image.writeUInt32LE(88, 20);
  image.writeUInt32LE(0x19, 32);
  image.writeUInt32LE(72, 36);
  image.write("__LINKEDIT", 40);
  image.writeBigUInt64LE(BigInt(4096 + signatureSize), 64);
  image.writeBigUInt64LE(128n, 72);
  image.writeBigUInt64LE(BigInt(signatureOffset - 128 + signatureSize), 80);
  image.writeUInt32LE(0x1d, 104);
  image.writeUInt32LE(16, 108);
  image.writeUInt32LE(signatureOffset, 112);
  image.writeUInt32LE(signatureSize, 116);
  image.writeUInt8(code, 128);
  image.fill(signatureByte, signatureOffset);
  return image;
}
