import type { GraphNode } from '../../types/graph';

interface GraphTooltipProps {
  node: GraphNode
  x: number
  y: number
}

export function GraphTooltip({ node, x, y }: GraphTooltipProps): JSX.Element {
  // Clamp tooltip to viewport: if too far right, flip to left side
  const tooltipWidth = 240;
  const left = x + tooltipWidth + 12 > window.innerWidth ? x - tooltipWidth - 12 : x + 12;
  const top = y - 8;

  return (
    <div
      className="graph-tooltip"
      style={{ left, top }}
    >
      <div className="graph-tooltip__type">{node.type.replace('_', ' ')}</div>
      <div className="graph-tooltip__label">{node.label}</div>
      {node.status && (
        <div className="graph-tooltip__row">
          <span>status</span>
          {node.status}
        </div>
      )}
      {node.branch && (
        <div className="graph-tooltip__row">
          <span>branch</span>
          {node.branch}
        </div>
      )}
      {node.repo && (
        <div className="graph-tooltip__row">
          <span>repo</span>
          {node.repo}
        </div>
      )}
      {node.labels && node.labels.length > 0 && (
        <div className="graph-tooltip__row">
          <span>labels</span>
          {node.labels.join(', ')}
        </div>
      )}
    </div>
  );
}
