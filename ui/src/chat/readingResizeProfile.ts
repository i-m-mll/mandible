// The v5 corpus remains a provisional resize shape; math-v6 exact geometry is authoritative.
import { readingResizeProfileData } from './readingResizeProfileData';
import type { MeasurementLayout } from './readingMeasurement';
function value(layout: MeasurementLayout): number {
  const variant = layout.responsiveVariant;
  if (variant !== 'wide' && variant !== 'narrow') throw new Error('Reading layout has no calibrated responsive variant.');
  const { rowWidths, ratios } = readingResizeProfileData.variants[variant];
  const width = layout.width;
  if (width <= rowWidths[0]) return ratios[0];
  const last = rowWidths.length - 1;
  if (width >= rowWidths[last]) return ratios[last];
  let low = 0; let high = last;
  while (high - low > 1) { const mid = (low + high) >>> 1; if (rowWidths[mid] <= width) low = mid; else high = mid; }
  const fraction = (1 / width - 1 / rowWidths[low]) / (1 / rowWidths[high] - 1 / rowWidths[low]);
  return ratios[low] + fraction * (ratios[high] - ratios[low]);
}
export function getReadingResizeScale(from: MeasurementLayout, to: MeasurementLayout): number {
  return value(to) / value(from);
}
