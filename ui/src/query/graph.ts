import { getGraph, type GraphQueryParams } from '../api';
import { projectionKeys } from './projectionKeys';
import { snapshotOptions } from './snapshots';

export function graphOptions(input: GraphQueryParams = {}) {
  const key = projectionKeys.graph(input);
  return snapshotOptions(key, (signal) => getGraph(key[1], { signal }));
}
