import type { MeasurementRow } from './readingMeasurement';

export type ReadingBodyDemand = {
  vector: readonly MeasurementRow[];
  required: readonly MeasurementRow[];
  visible?: readonly MeasurementRow[];
  prefetch: readonly MeasurementRow[];
  start: number;
  end: number;
  height: number;
  offset?:number;
};
