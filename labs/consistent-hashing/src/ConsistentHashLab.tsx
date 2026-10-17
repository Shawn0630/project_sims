import { useMemo, useRef, useState } from 'react';

/**
 * ConsistentHashLab — interactive consistent-hashing ring.
 *
 * Used standalone (Labs view) and embedded in the DB / NoSQL deep-dive panel.
 * Shows: virtual nodes on a real 2^32 ring, key ownership by color, animated
 * migration when nodes join/leave, the migration fraction vs naive
 * hash % N, per-node load and imbalance, and the getNode() code path with
 * the line for the current lookup highlighted.
 */

const RING = 2 ** 32;
const NODE_COLORS = ['#60a5fa', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171'];
const NODE_NAMES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface VNode {
  pos: number;
  node: string;
}

function buildRing(nodes: string[], vnodes: number): VNode[] {
  const ring: VNode[] = [];
  for (const node of nodes) {
    for (let i = 0; i < vnodes; i++) ring.push({ pos: fnv1a(`${node}#${i}`), node });
  }
  return ring.sort((a, b) => a.pos - b.pos);
}

function ownerOf(ring: VNode[], keyPos: number): string {
  let lo = 0;
  let hi = ring.length - 1;
  let ans = ring[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid]!.pos >= keyPos) {
      ans = ring[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (ring[ring.length - 1]!.pos < keyPos) ans = ring[0];
  return ans!.node;
}

function modOwner(nodes: string[], key: string): string {
  return nodes[fnv1a(key) % nodes.length]!;
}

export interface ConsistentHashLabProps {
  /** Render a denser, smaller variant for embedding in deep-dive panels. */
  compact?: boolean;
  /** Externally supplied keys (e.g. sampled from a live component key stream). */
  seedKeys?: string[];
}

export function ConsistentHashLab({ compact = false, seedKeys }: ConsistentHashLabProps) {
  const [nodes, setNodes] = useState<string[]>(['S1', 'S2', 'S3']);
  const [vnodes, setVnodes] = useState(compact ? 20 : 50);
  const [keyCount, setKeyCount] = useState(compact ? 36 : 60);
  const [seed, setSeed] = useState(1);
  const [lastChange, setLastChange] = useState<string>('拖动虚拟节点数，或增删分片，看 key 如何迁移。');
  const [movedKeys, setMovedKeys] = useState<Set<string>>(new Set());
  const [lookup, setLookup] = useState<{ key: string; node: string; pos: number } | null>(null);
  const prevAssignment = useRef<Map<string, string> | null>(null);
  const prevNodes = useRef<string[]>(nodes);

  const keys = useMemo(() => {
    if (seedKeys && seedKeys.length > 0) return seedKeys.slice(0, 240);
    return Array.from({ length: keyCount }, (_, i) => `user:${seed * 10000 + i * 137}`);
  }, [seedKeys, keyCount, seed]);

  const ring = useMemo(() => buildRing(nodes, vnodes), [nodes, vnodes]);
  const assignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const k of keys) map.set(k, ownerOf(ring, fnv1a(k)));
    return map;
  }, [ring, keys]);

  const perNode = useMemo(() => {
    const counts = new Map<string, number>(nodes.map((n) => [n, 0]));
    for (const owner of assignment.values()) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    return counts;
  }, [assignment, nodes]);

  const applyNodeChange = (next: string[], verb: string) => {
    if (next.length === 0) return;
    const nextRing = buildRing(next, vnodes);
    const nextAssign = new Map<string, string>();
    for (const k of keys) nextAssign.set(k, ownerOf(nextRing, fnv1a(k)));
    let moved = 0;
    const movedSet = new Set<string>();
    for (const k of keys) {
      if (assignment.get(k) !== nextAssign.get(k)) {
        moved += 1;
        movedSet.add(k);
      }
    }
    let modMoved = 0;
    if (prevNodes.current.length > 0) {
      for (const k of keys) {
        if (modOwner(prevNodes.current, k) !== modOwner(next, k)) modMoved += 1;
      }
    }
    const total = keys.length;
    setLastChange(
      `${verb}：一致性哈希迁移 ${moved}/${total} 个 key（${((moved / total) * 100).toFixed(1)}%），` +
        `普通 hash % N 会迁移 ${modMoved}/${total}（${((modMoved / total) * 100).toFixed(1)}%）。`,
    );
    setMovedKeys(movedSet);
    window.setTimeout(() => setMovedKeys(new Set()), 1400);
    prevAssignment.current = nextAssign;
    prevNodes.current = next;
    setNodes(next);
  };

  const addNode = () => {
    const name = NODE_NAMES.find((n) => !nodes.includes(n));
    if (name) applyNodeChange([...nodes, name], `加入分片 ${name}`);
  };
  const removeNode = (name: string) => {
    if (nodes.length <= 1) return;
    applyNodeChange(
      nodes.filter((n) => n !== name),
      `下线分片 ${name}`,
    );
  };

  const size = compact ? 300 : 420;
  const cx = size / 2;
  const cy = size / 2;
  const rVnode = size * 0.36;
  const rKey = size * 0.45;
  const polar = (pos: number, r: number) => {
    const angle = (pos / RING) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  };
  const colorOf = (node: string) => NODE_COLORS[NODE_NAMES.indexOf(node) % NODE_COLORS.length];
  const counts = [...perNode.values()];
  const avg = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const imbalance = avg > 0 ? (Math.max(...counts) / avg).toFixed(2) : '—';

  const doLookup = (key: string) => {
    const pos = fnv1a(key);
    setLookup({ key, node: ownerOf(ring, pos), pos });
  };

  return (
    <div style={{ fontFamily: 'inherit', color: 'inherit' }}>
      <style>{`@keyframes chlpulse { 0% { opacity: 1; } 50% { opacity: .25; } 100% { opacity: 1; } }`}</style>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <svg width={size} height={size} style={{ flexShrink: 0 }}>
          <circle cx={cx} cy={cy} r={rVnode} fill="none" stroke="#475569" strokeWidth={10} opacity={0.35} />
          {ring.map((v, i) => {
            const p = polar(v.pos, rVnode);
            return (
              <circle key={i} cx={p.x} cy={p.y} r={vnodes > 80 ? 1.6 : 2.6} fill={colorOf(v.node)} />
            );
          })}
          {keys.map((k) => {
            const pos = fnv1a(k);
            const p = polar(pos, rKey);
            const owner = assignment.get(k)!;
            const isMoved = movedKeys.has(k);
            const isLookup = lookup?.key === k;
            return (
              <circle
                key={k}
                cx={p.x}
                cy={p.y}
                r={isLookup ? 6 : 3.4}
                fill={colorOf(owner)}
                stroke={isLookup ? '#fff' : 'none'}
                strokeWidth={isLookup ? 2 : 0}
                style={{
                  cursor: 'pointer',
                  animation: isMoved ? 'chlpulse .45s ease-in-out 3' : undefined,
                }}
                onClick={() => doLookup(k)}
              >
                <title>{`${k} → ${owner}`}</title>
              </circle>
            );
          })}
          {lookup && (
            <circle {...polar(lookup.pos, rVnode)} r={7} fill="none" stroke="#fff" strokeWidth={2} />
          )}
          <text x={cx} y={cy - 6} textAnchor="middle" fill="#e2e8f0" fontSize={13}>
            {nodes.length} 个分片 · {vnodes} 虚拟节点/片
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" fill="#94a3b8" fontSize={11}>
            {keys.length} 个 key · 不均衡比 {imbalance}
          </text>
        </svg>

        <div style={{ flex: 1, minWidth: 230 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button onClick={addNode} disabled={nodes.length >= 8}>
              ＋ 加一个分片
            </button>
            <button onClick={() => setSeed(seed + 1)}>🎲 换一批 key</button>
          </div>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            虚拟节点/片：{vnodes}
            <input
              type="range"
              min={1}
              max={200}
              value={vnodes}
              onChange={(ev) => setVnodes(Number(ev.target.value))}
              style={{ width: '100%' }}
            />
          </label>
          {!seedKeys && (
            <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
              key 数量：{keyCount}
              <input
                type="range"
                min={12}
                max={240}
                step={12}
                value={keyCount}
                onChange={(ev) => setKeyCount(Number(ev.target.value))}
                style={{ width: '100%' }}
              />
            </label>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
            {nodes.map((nodeName) => (
              <div key={nodeName} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: colorOf(nodeName) }} />
                <span style={{ width: 28 }}>{nodeName}</span>
                <div style={{ flex: 1, height: 8, background: '#1e293b', borderRadius: 4 }}>
                  <div
                    style={{
                      height: 8,
                      borderRadius: 4,
                      background: colorOf(nodeName),
                      width: `${((perNode.get(nodeName) ?? 0) / Math.max(1, keys.length)) * 100}%`,
                    }}
                  />
                </div>
                <span>
                  {perNode.get(nodeName) ?? 0} key（
                  {(((perNode.get(nodeName) ?? 0) / Math.max(1, keys.length)) * 100).toFixed(0)}%）
                </span>
                <button onClick={() => removeNode(nodeName)} disabled={nodes.length <= 1}>
                  下线
                </button>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 8 }}>
            {lastChange}
          </div>
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <div style={{ marginBottom: 4 }}>
              点任意 key 或输入 key 名，单步执行 getNode：
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder="user:1024"
                id="chl-lookup-input"
                style={{ flex: 1 }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    doLookup((ev.target as HTMLInputElement).value || 'user:1024');
                  }
                }}
              />
              <button
                onClick={() => {
                  const el = document.getElementById('chl-lookup-input') as HTMLInputElement | null;
                  doLookup(el?.value || 'user:1024');
                }}
              >
                查找
              </button>
            </div>
            {lookup && (
              <div style={{ marginTop: 6 }}>
                hash({lookup.key}) = {lookup.pos} → 沿环顺时针第一个虚拟节点属于{' '}
                <b style={{ color: colorOf(lookup.node) }}>{lookup.node}</b>
              </div>
            )}
          </div>
          {!compact && (
            <pre
              style={{
                marginTop: 12,
                fontSize: 11.5,
                lineHeight: 1.65,
                background: '#0b1220',
                border: '1px solid #1e293b',
                borderRadius: 6,
                padding: 10,
                overflowX: 'auto',
              }}
            >
              {[
                'function getNode(key) {',
                '  const h = hash(key);            // 1. 算 key 的哈希',
                '  // 2. 在排序好的虚拟节点环上二分',
                '  const v = firstVNodeAtOrAfter(h);',
                '  return v.owner;                 // 3. 返回归属分片',
                '}',
              ].map((line, i) => (
                <div
                  key={i}
                  style={{
                    background: lookup ? (i === 1 || i === 3 ? '#1e3a5f' : undefined) : undefined,
                    borderRadius: 3,
                    padding: '0 4px',
                    whiteSpace: 'pre',
                  }}
                >
                  {line}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
