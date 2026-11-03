import type { MeasurementRow } from './readingMeasurement';

type RowKeys = {
  key: string; revision: string; disclosure: string; body: string;
  payloadKey?: string; bodyKey?: string; measurement?: { layout: string; key: string };
};
// Follow retained row lifetime and keep only the latest layout variant per row.
const keys = new WeakMap<MeasurementRow, RowKeys>();

function rowKeys(row: MeasurementRow): RowKeys {
  const disclosure = row.disclosureIdentity ?? '';
  const body = row.bodyIdentity ?? disclosure;
  let cached = keys.get(row);
  if (!cached || cached.key !== row.key || cached.revision !== row.revision) {
    cached = { key: row.key, revision: row.revision, disclosure, body };
    keys.set(row, cached);
  } else {
    if (cached.disclosure !== disclosure) {
      cached.disclosure = disclosure;
      cached.payloadKey = undefined;
      cached.measurement = undefined;
    }
    if (cached.body !== body) { cached.body = body; cached.bodyKey = undefined; }
  }
  return cached;
}

export function readingPayloadKey(row: MeasurementRow): string {
  const cached = rowKeys(row);
  return cached.payloadKey ??= JSON.stringify([cached.key, cached.revision, cached.disclosure]);
}
export function readingBodyKey(row: MeasurementRow): string {
  const cached = rowKeys(row);
  return cached.bodyKey ??= JSON.stringify([cached.key, cached.revision, cached.body]);
}
export function readingMeasurementKey(row: MeasurementRow, layout: string): string {
  const cached = rowKeys(row);
  if (cached.measurement?.layout !== layout) {
    cached.measurement = { layout, key: JSON.stringify([cached.key, cached.revision, cached.disclosure, layout]) };
  }
  return cached.measurement.key;
}
