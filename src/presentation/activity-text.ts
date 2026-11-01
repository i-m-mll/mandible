function stripPairedMarker(value: string, marker: '**' | '__'): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf(marker, cursor);
    if (opening < 0) return output + value.slice(cursor);
    const beforeOpening = value[opening - 1];
    const afterOpening = value[opening + marker.length];
    if ((beforeOpening && /[\p{L}\p{N}_]/u.test(beforeOpening)) || !afterOpening || /\s/u.test(afterOpening)) {
      output += value.slice(cursor, opening + marker.length);
      cursor = opening + marker.length;
      continue;
    }
    let closing = value.indexOf(marker, opening + marker.length);
    while (closing >= 0) {
      const beforeClosing = value[closing - 1];
      const afterClosing = value[closing + marker.length];
      if (beforeClosing && !/\s/u.test(beforeClosing)
          && (!afterClosing || !/[\p{L}\p{N}_]/u.test(afterClosing))) break;
      closing = value.indexOf(marker, closing + marker.length);
    }
    if (closing < 0) return output + value.slice(cursor);
    output += value.slice(cursor, opening) + value.slice(opening + marker.length, closing);
    cursor = closing + marker.length;
  }
  return output;
}

export function plainActivityHeader(value: string): string {
  return stripPairedMarker(stripPairedMarker(value, '**'), '__');
}
