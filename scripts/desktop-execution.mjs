import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ARM64 = 0x0100000c;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;

/** Keep the executable and its linkage, disregarding the trailing code-signature seal. */
export function desktopMachOIdentity(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== MH_MAGIC_64 || bytes.readUInt32LE(4) !== ARM64) {
    throw new Error('Desktop execution identity requires the qualified arm64 Mach-O image.');
  }
  const commandEnd = 32 + bytes.readUInt32LE(20);
  let linkedit;
  let signature;
  for (let offset = 32; offset < commandEnd;) {
    if (offset + 8 > commandEnd || commandEnd > bytes.length) throw new Error('Invalid desktop Mach-O load commands.');
    const kind = bytes.readUInt32LE(offset);
    const length = bytes.readUInt32LE(offset + 4);
    if (length < 8 || length % 8 || offset + length > commandEnd) throw new Error('Invalid desktop Mach-O command size.');
    if (kind === LC_SEGMENT_64 && length >= 72 && bytes.toString('ascii', offset + 8, offset + 24).replace(/\0+$/, '') === '__LINKEDIT') {
      if (linkedit !== undefined) throw new Error('Multiple desktop Mach-O link-edit segments.');
      linkedit = offset;
    }
    if (kind === LC_CODE_SIGNATURE) {
      if (length !== 16 || signature !== undefined) throw new Error('Invalid desktop Mach-O code signature.');
      signature = offset;
    }
    offset += length;
  }
  if (signature === undefined || linkedit === undefined) throw new Error('Desktop Mach-O has no trailing signature to normalize.');
  const end = bytes.readUInt32LE(signature + 8);
  const size = bytes.readUInt32LE(signature + 12);
  const linkeditStart = bytes.readBigUInt64LE(linkedit + 40);
  if (end < commandEnd || BigInt(end) < linkeditStart || end + size !== bytes.length) {
    throw new Error('Desktop Mach-O signature is outside its trailing file range.');
  }
  const canonical = Buffer.from(bytes.subarray(0, end));
  canonical.writeUInt32LE(0, signature + 12);
  const mappedLength = BigInt(end) - linkeditStart;
  canonical.writeBigUInt64LE(mappedLength, linkedit + 48);
  canonical.writeBigUInt64LE(mappedLength, linkedit + 32);
  return createHash('sha256').update(canonical).digest('hex');
}

export function desktopExecutionIdentity(app, signer, identifier, entitlements) {
  const contents = path.join(app, 'Contents');
  const executable = path.join(contents, 'MacOS/mandible-app');
  const dependencies = signer.run('/usr/bin/otool', ['-L', executable]).split('\n')
    .slice(1).filter(Boolean).map(row => {
      const match = /^\s+(.+?) \(compatibility version /.exec(row);
      if (!match) throw new Error('Could not classify a desktop executable library.');
      return match[1];
    }).filter(library => !library.startsWith('/System/Library/') && !library.startsWith('/usr/lib/'));
  const libraryIdentity = dependencies.map(library => {
    const relative = library.replace(/^@(?:executable_path|loader_path)\//, 'MacOS/')
      .replace(/^@rpath\//, 'Frameworks/');
    const file = fs.realpathSync(path.resolve(contents, relative));
    if (!file.startsWith(`${contents}${path.sep}`)) throw new Error(`Desktop library leaves the application: ${library}`);
    return [library, createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  });
  const launchContext = JSON.stringify({ identifier, certificate: signer.identity, hardenedRuntime: signer.plan.hardenedRuntime, libraryIdentity });
  return createHash('sha256').update(JSON.stringify([
    'mandible-desktop-execution@1',
    desktopMachOIdentity(fs.readFileSync(executable)),
    launchContext,
    fs.readFileSync(path.join(contents, 'Info.plist')).toString('base64'),
    entitlements ? fs.readFileSync(entitlements).toString('base64') : null,
  ])).digest('hex');
}
