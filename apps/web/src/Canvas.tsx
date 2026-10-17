import { useRef } from 'react';
import { componentDef } from '@sds/components';
import type { Design, MetricsSnapshot } from '@sds/sim-core';
import { IconGlyph } from './icons';

const NODE_W = 118;
const NODE_H = 68;

function utilColor(util: number, killed: boolean): string {
  if (killed) return '#64748b';
  if (util >= 1) return '#f87171';
  if (util >= 0.7) return '#facc15';
  return '#4ade80';
}

interface CanvasProps {
  design: Design;
  snapshot: MetricsSnapshot | null;
  selectedId: string | null;
  highlighted: Map<string, string>;
  running: boolean;
  connectMode: boolean;
  connectFrom: string | null;
  onNodePress: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onBackgroundPress: () => void;
}

export function Canvas({
  design,
  snapshot,
  selectedId,
  highlighted,
  running,
  connectMode,
  connectFrom,
  onNodePress,
  onMove,
  onBackgroundPress,
}: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);

  const toSVG = (evt: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = new DOMPoint(evt.clientX, evt.clientY);
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const nodeById = new Map(design.nodes.map((n) => [n.id, n]));

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 960 600"
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        background:
          'radial-gradient(circle at 1px 1px, #1e293b 1px, transparent 0) 0 0 / 24px 24px, #0b1220',
        borderRadius: 10,
        border: '1px solid #1e293b',
        touchAction: 'none',
        cursor: connectMode ? 'crosshair' : 'default',
      }}
      onPointerDown={(evt) => {
        if (evt.target === evt.currentTarget) onBackgroundPress();
      }}
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#64748b" />
        </marker>
      </defs>

      {/* edges */}
      {design.edges.map((edge) => {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) return null;
        const targetIn = snapshot?.nodes[edge.to]?.inQps ?? 0;
        const particles = running && targetIn > 20 ? 3 : running && targetIn > 2 ? 2 : 0;
        const dur = targetIn > 500 ? '0.8s' : targetIn > 100 ? '1.3s' : '2s';
        return (
          <g key={edge.id}>
            <path
              id={`path-${edge.id}`}
              d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
              stroke="#475569"
              strokeWidth={1.6}
              fill="none"
              markerEnd="url(#arrow)"
              opacity={0.75}
            />
            {Array.from({ length: particles }, (_, i) => (
              <circle key={i} r={3} fill={componentDef(to.type).color} opacity={0.9}>
                <animateMotion dur={dur} begin={`${-i * 0.55}s`} repeatCount="indefinite">
                  <mpath href={`#path-${edge.id}`} />
                </animateMotion>
              </circle>
            ))}
          </g>
        );
      })}

      {/* nodes */}
      {design.nodes.map((node) => {
        const def = componentDef(node.type);
        const m = snapshot?.nodes[node.id];
        const killed = m?.killed ?? false;
        const util = m?.util ?? 0;
        const selected = node.id === selectedId;
        const isConnectFrom = node.id === connectFrom;
        const hl = highlighted.get(node.id);
        return (
          <g
            key={node.id}
            transform={`translate(${node.x},${node.y})`}
            style={{ cursor: 'grab' }}
            onPointerDown={(evt) => {
              evt.stopPropagation();
              const p = toSVG(evt);
              drag.current = { id: node.id, dx: p.x - node.x, dy: p.y - node.y, moved: false };
              (evt.target as Element).setPointerCapture?.(evt.pointerId);
            }}
            onPointerMove={(evt) => {
              const d = drag.current;
              if (!d || d.id !== node.id) return;
              const p = toSVG(evt);
              const nx = Math.max(50, Math.min(910, p.x - d.dx));
              const ny = Math.max(36, Math.min(564, p.y - d.dy));
              if (Math.abs(nx - node.x) + Math.abs(ny - node.y) > 2) d.moved = true;
              if (d.moved) onMove(node.id, nx, ny);
            }}
            onPointerUp={(evt) => {
              const d = drag.current;
              drag.current = null;
              if (d && d.id === node.id && !d.moved) onNodePress(node.id);
              evt.stopPropagation();
            }}
          >
            {hl && (
              <rect
                x={-NODE_W / 2 - 6}
                y={-NODE_H / 2 - 6}
                width={NODE_W + 12}
                height={NODE_H + 12}
                rx={12}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={2.4}
                strokeDasharray="6 4"
              >
                <title>{hl}</title>
              </rect>
            )}
            <rect
              x={-NODE_W / 2}
              y={-NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx={10}
              fill={killed ? '#1f2937' : '#111c30'}
              stroke={selected ? '#e2e8f0' : isConnectFrom ? '#38bdf8' : utilColor(util, killed)}
              strokeWidth={selected || isConnectFrom ? 2.6 : 1.8}
              opacity={killed ? 0.65 : 1}
            />
            <g transform="translate(-38,-14)" style={{ color: killed ? '#64748b' : def.color }}>
              <IconGlyph icon={def.icon} size={30} />
            </g>
            <text x={-16} y={-8} fill={killed ? '#64748b' : '#e2e8f0'} fontSize={12.5} fontWeight={600}>
              {node.label ?? def.name}
            </text>
            <text x={-16} y={9} fill="#94a3b8" fontSize={10.5}>
              {def.nameEn} · ×{node.settings.replicas}
            </text>
            <text x={-NODE_W / 2 + 10} y={NODE_H / 2 - 8} fill={utilColor(util, killed)} fontSize={11}>
              {killed
                ? '✕ 已宕机'
                : snapshot
                  ? `${Math.round(m?.inQps ?? 0)} req/s · 利用率 ${Math.round(util * 100)}%${
                      m?.queueDepth !== undefined && m.queueDepth > 0
                        ? ` · 积压 ${Math.round(m.queueDepth)}`
                        : ''
                    }`
                  : def.blurb.slice(0, 12)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
