import type { MeasurementRow } from './readingMeasurement';

export type ReadingBodyDemand = {
  vector: readonly MeasurementRow[];
  required: readonly MeasurementRow[];
  prefetch: readonly MeasurementRow[];
  start: number;
  end: number;
  height: number;
};
