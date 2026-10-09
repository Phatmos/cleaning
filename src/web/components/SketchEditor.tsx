import { useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeTag, GeometryInput, Opening, Pt, Shape } from '../../shared/types';
import { computeGeometry, shapeEdges, shapeToPoints, arcAccuracy } from '../../engine/geometry';
import { formatFtIn, fmtSqFt } from '../../engine/units';
import { uid } from '../lib/api';
import { Field, LengthInput, NumberInput, Segmented, Sheet } from './ui';

type Tool = 'select' | 'poly' | 'cutout';
type Sel = { kind: 'shape'; id: string; cutout?: boolean } | { kind: 'edge'; key: string } | null;

const TAG_COLORS = { house: '#8e8e93', ledger: '#8b5a2b', rail: 'var(--accent)', open: 'var(--text)' };

export function SketchEditor({ geometry, onChange, onOverride }: { geometry: GeometryInput; onChange: (g: GeometryInput) => void; onOverride: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ scale: 2, ox: 80, oy: 420 }); // px per inch; screen origin of world (0,0)
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [undo, setUndo] = useState<GeometryInput[]>([]);
  const [redo, setRedo] = useState<GeometryInput[]>([]);
  const [addOpen, setAddOpen] = useState<null | 'rect' | 'tri' | 'arc'>(null);
  const drag = useRef<{ mode: 'pan' | 'move'; start: Pt; orig: any; id?: string; cut?: boolean; moved?: boolean } | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  const pinch = useRef<{ d: number; scale: number; mid: Pt } | null>(null);
  const geo = useMemo(() => computeGeometry(geometry.shapes, geometry.cutouts), [geometry.shapes, geometry.cutouts]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Fit to content on first render with shapes
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && geometry.shapes.length && size.w) { fit(); fitted.current = true; } }, [geometry.shapes.length, size.w]);

  const commit = (g: GeometryInput) => { setUndo((u) => [...u.slice(-49), geometry]); setRedo([]); onChange(g); };
  const doUndo = () => { const p = undo[undo.length - 1]; if (!p) return; setUndo(undo.slice(0, -1)); setRedo([geometry, ...redo]); onChange(p); };
  const doRedo = () => { const n = redo[0]; if (!n) return; setRedo(redo.slice(1)); setUndo([...undo, geometry]); onChange(n); };

  const toScreen = (p: Pt) => ({ x: p.x * view.scale + view.ox, y: -p.y * view.scale + view.oy });
  const toWorld = (sx: number, sy: number): Pt => ({ x: (sx - view.ox) / view.scale, y: -(sy - view.oy) / view.scale });
  const evPt = (e: React.PointerEvent | React.WheelEvent) => { const r = svgRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const snap = (v: number, step = 6) => Math.round(v / step) * step;

  function fit() {
    const pts = [...geometry.shapes, ...geometry.cutouts].flatMap(shapeToPoints);
    if (!pts.length) { setView({ scale: 2, ox: 80, oy: size.h - 80 }); return; }
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const pad = 70;
    const scale = Math.min((size.w - pad * 2) / Math.max(maxX - minX, 24), (size.h - pad * 2) / Math.max(maxY - minY, 24));
    setView({ scale, ox: pad - minX * scale + ((size.w - pad * 2) - (maxX - minX) * scale) / 2, oy: size.h - pad + minY * scale - ((size.h - pad * 2) - (maxY - minY) * scale) / 2 });
  }

  const zoomAt = (sx: number, sy: number, factor: number) => setView((v) => {
    const scale = Math.min(20, Math.max(0.3, v.scale * factor));
    const k = scale / v.scale;
    return { scale, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k };
  });

  const translateShape = (s: Shape, dx: number, dy: number): Shape => {
    switch (s.kind) {
      case 'rect': case 'triangle': return { ...s, x: s.x + dx, y: s.y + dy };
      case 'polygon': return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      case 'arc': return { ...s, p1: { x: s.p1.x + dx, y: s.p1.y + dy }, p2: { x: s.p2.x + dx, y: s.p2.y + dy } };
    }
  };

  /** Snap a moved shape so one of its corners lands on a nearby corner of another shape. */
  const vertexSnap = (moved: Shape, others: Shape[]): Shape => {
    const thr = 10 / view.scale + 3;
    let best: { dx: number; dy: number; d: number } | null = null;
    const mine = shapeToPoints(moved);
    const theirs = others.flatMap(shapeToPoints);
    for (const a of mine) for (const b of theirs) {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < thr && (!best || d < best.d)) best = { dx: b.x - a.x, dy: b.y - a.y, d };
    }
    return best ? translateShape(moved, best.dx, best.dy) : moved;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = evPt(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      drag.current = null;
      return;
    }
    const target = (e.target as Element).closest('[data-shape],[data-edge]') as HTMLElement | null;
    if (tool === 'poly' || tool === 'cutout') {
      const w = toWorld(p.x, p.y);
      const pt = { x: snap(w.x), y: snap(w.y) };
      if (draft.length >= 3) {
        const f = toScreen(draft[0]);
        if (Math.hypot(f.x - p.x, f.y - p.y) < 18) return finishPoly();
      }
      setDraft([...draft, pt]);
      return;
    }
    if (target?.dataset.edge) { setSel({ kind: 'edge', key: target.dataset.edge }); drag.current = { mode: 'pan', start: p, orig: { ...view } }; return; }
    if (target?.dataset.shape) {
      const cut = target.dataset.cut === '1';
      const list = cut ? geometry.cutouts : geometry.shapes;
      const s = list.find((x) => x.id === target.dataset.shape)!;
      setSel({ kind: 'shape', id: s.id, cutout: cut });
      drag.current = { mode: 'move', start: p, orig: s, id: s.id, cut };
      return;
    }
    setSel(null);
    drag.current = { mode: 'pan', start: p, orig: { ...view } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = evPt(e);
    pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const target = Math.min(20, Math.max(0.3, pinch.current.scale * (d / pinch.current.d)));
      zoomAt(pinch.current.mid.x, pinch.current.mid.y, target / view.scale);
      return;
    }
    const dr = drag.current;
    if (!dr) return;
    if (dr.mode === 'pan') setView({ ...dr.orig, ox: dr.orig.ox + p.x - dr.start.x, oy: dr.orig.oy + p.y - dr.start.y });
    else {
      const dx = snap((p.x - dr.start.x) / view.scale, 1);
      const dy = snap(-(p.y - dr.start.y) / view.scale, 1);
      if (!dx && !dy && !dr.moved) return;
      dr.moved = true;
      const key = dr.cut ? 'cutouts' : 'shapes';
      let moved = translateShape(dr.orig, dx, dy);
      if (!dr.cut) moved = vertexSnap(moved, geometry.shapes.filter((s) => s.id !== dr.id));
      onChange({ ...geometry, [key]: geometry[key].map((s) => (s.id === dr.id ? moved : s)) });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const dr = drag.current;
    if (dr?.mode === 'move' && dr.moved) { setUndo((u) => [...u.slice(-49), { ...geometry, [dr.cut ? 'cutouts' : 'shapes']: geometry[dr.cut ? 'cutouts' : 'shapes'].map((s) => (s.id === dr.id ? dr.orig : s)) }]); setRedo([]); }
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => { const p = evPt(e); zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12); };

  function finishPoly() {
    if (draft.length < 3) { setDraft([]); return; }
    const isCut = tool === 'cutout';
    const s: Shape = { id: uid().slice(0, 6), label: isCut ? `Cutout ${geometry.cutouts.length + 1}` : `Area ${geometry.shapes.length + 1}`, kind: 'polygon', points: draft };
    commit(isCut ? { ...geometry, cutouts: [...geometry.cutouts, s] } : { ...geometry, shapes: [...geometry.shapes, s] });
    setDraft([]);
    setTool('select');
    setSel({ kind: 'shape', id: s.id, cutout: isCut });
  }

  const nextOrigin = (): Pt => (geo.valid ? { x: geo.bbox.maxX, y: geo.bbox.minY } : { x: 0, y: 0 });
  const addShape = (s: Shape) => { commit({ ...geometry, shapes: [...geometry.shapes, s] }); setSel({ kind: 'shape', id: s.id }); setAddOpen(null); setTimeout(fit, 0); };
  const updateShape = (id: string, patch: Partial<Shape>, cut?: boolean) => {
    const key = cut ? 'cutouts' : 'shapes';
    commit({ ...geometry, [key]: geometry[key].map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)) });
  };
  const removeShape = (id: string, cut?: boolean) => {
    const key = cut ? 'cutouts' : 'shapes';
    const edgeTags = Object.fromEntries(Object.entries(geometry.edgeTags).filter(([k]) => !k.startsWith(`${id}:`)));
    commit({ ...geometry, [key]: geometry[key].filter((s) => s.id !== id), edgeTags, openings: geometry.openings.filter((o) => !o.edgeKey.startsWith(`${id}:`)) });
    setSel(null);
  };
  const setTag = (key: string, patch: Partial<EdgeTag>) => {
    const cur = geometry.edgeTags[key] ?? { side: 'open' };
    const next: EdgeTag = { ...cur, ...patch };
    if (next.side === 'house') { next.rail = false; next.fascia = false; }
    if (next.side === 'open') next.ledger = false;
    commit({ ...geometry, edgeTags: { ...geometry.edgeTags, [key]: next } });
  };

  // grid
  const tl = toWorld(0, 0), br = toWorld(size.w, size.h);
  const gridStep = view.scale < 0.8 ? 60 : 12;
  const gridLines: JSX.Element[] = [];
  for (let x = Math.floor(tl.x / gridStep) * gridStep; x < br.x; x += gridStep) {
    const sx = toScreen({ x, y: 0 }).x;
    gridLines.push(<line key={`x${x}`} x1={sx} x2={sx} y1={0} y2={size.h} stroke="var(--sep)" strokeWidth={x % 60 === 0 ? 1 : 0.5} />);
  }
  for (let y = Math.floor(br.y / gridStep) * gridStep; y < tl.y; y += gridStep) {
    const sy = toScreen({ x: 0, y }).y;
    gridLines.push(<line key={`y${y}`} y1={sy} y2={sy} x1={0} x2={size.w} stroke="var(--sep)" strokeWidth={y % 60 === 0 ? 1 : 0.5} />);
  }
  const ringPath = (pts: Pt[]) => pts.map((p, i) => { const s = toScreen(p); return `${i ? 'L' : 'M'}${s.x},${s.y}`; }).join(' ') + 'Z';
  const selShape = sel?.kind === 'shape' ? (sel.cutout ? geometry.cutouts : geometry.shapes).find((s) => s.id === sel.id) : undefined;
  const selEdgeKey = sel?.kind === 'edge' ? sel.key : undefined;
  const selSource = selEdgeKey ? [...geometry.shapes, ...geometry.cutouts].flatMap(shapeEdges).find((e) => e.key === selEdgeKey) : undefined;
  const deckDir = geometry.deckingAngleDeg;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
      <div className="sketch">
        <svg ref={svgRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} onDoubleClick={() => (tool !== 'select' ? finishPoly() : undefined)}>
          <rect width={size.w} height={size.h} fill="var(--bg-elev)" />
          {gridLines}
          {geo.valid && geo.polygons.map((poly, i) => (
            <path key={i} d={poly.map((r) => ringPath(r.slice(0, -1).map(([x, y]) => ({ x, y })))).join(' ')} fill="rgba(201,138,11,0.16)" fillRule="evenodd" />
          ))}
          {geometry.shapes.map((s) => (
            <path key={s.id} data-shape={s.id} d={ringPath(shapeToPoints(s))} fill={sel?.kind === 'shape' && sel.id === s.id ? 'rgba(0,113,227,0.12)' : 'transparent'} stroke="var(--text-3)" strokeDasharray="4 4" strokeWidth={1} style={{ cursor: 'move' }} />
          ))}
          {geometry.cutouts.map((s) => (
            <path key={s.id} data-shape={s.id} data-cut="1" d={ringPath(shapeToPoints(s))} fill="var(--bg-elev)" stroke="var(--red)" strokeDasharray="3 3" style={{ cursor: 'move' }} />
          ))}
          {geo.valid && geo.edges.map((e, i) => {
            const t = e.sourceKey ? geometry.edgeTags[e.sourceKey] : undefined;
            const color = t?.side === 'house' ? (t.ledger ? TAG_COLORS.ledger : TAG_COLORS.house) : t?.rail ? TAG_COLORS.rail : TAG_COLORS.open;
            const a = toScreen(e.a), b = toScreen(e.b);
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len; // outward for CCW in screen (y flipped)
            const selected = e.sourceKey && e.sourceKey === selEdgeKey;
            const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
            const rot = ang > 90 || ang < -90 ? ang + 180 : ang;
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={selected ? 'var(--orange)' : color} strokeWidth={t?.side === 'house' ? 6 : t?.rail ? 4 : 2.5} strokeLinecap="round" />
                {t?.fascia && <line x1={a.x + nx * 5} y1={a.y + ny * 5} x2={b.x + nx * 5} y2={b.y + ny * 5} stroke="#c45d00" strokeWidth={2} />}
                <line data-edge={e.sourceKey} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={22} style={{ cursor: 'pointer' }} />
                {len > 34 && <text x={mx + nx * 16} y={my + ny * 16} fontSize={12} fontWeight={600} textAnchor="middle" dominantBaseline="middle" fill="var(--text)" transform={`rotate(${rot} ${mx + nx * 16} ${my + ny * 16})`} style={{ pointerEvents: 'none' }}>{formatFtIn(e.length)}</text>}
              </g>
            );
          })}
          {geometry.openings.map((o) => {
            const se = [...geometry.shapes].flatMap(shapeEdges).find((x) => x.key === o.edgeKey);
            if (!se) return null;
            const dx = (se.b.x - se.a.x) / se.length, dy = (se.b.y - se.a.y) / se.length;
            const a = toScreen({ x: se.a.x + dx * o.offsetIn, y: se.a.y + dy * o.offsetIn });
            const b = toScreen({ x: se.a.x + dx * (o.offsetIn + o.widthIn), y: se.a.y + dy * (o.offsetIn + o.widthIn) });
            return <g key={o.id} style={{ pointerEvents: 'none' }}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={o.kind === 'gate' ? '#248a3d' : '#8e44ad'} strokeWidth={8} strokeLinecap="butt" />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 10} fontSize={11} textAnchor="middle" fill={o.kind === 'gate' ? '#248a3d' : '#8e44ad'} fontWeight={700}>{o.kind === 'gate' ? 'GATE' : 'STAIRS'}</text>
            </g>;
          })}
          {draft.length > 0 && <g style={{ pointerEvents: 'none' }}>
            <polyline points={draft.map((p) => { const s = toScreen(p); return `${s.x},${s.y}`; }).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2} />
            {draft.map((p, i) => { const s = toScreen(p); return <circle key={i} cx={s.x} cy={s.y} r={i === 0 ? 9 : 5} fill={i === 0 ? 'var(--accent-soft)' : 'var(--accent)'} stroke="var(--accent)" />; })}
          </g>}
          {geo.valid && (() => {
            const c = toScreen({ x: (geo.bbox.minX + geo.bbox.maxX) / 2, y: (geo.bbox.minY + geo.bbox.maxY) / 2 });
            const r = (deckDir * Math.PI) / 180;
            return <g opacity={0.55} style={{ pointerEvents: 'none' }}>
              <line x1={c.x - Math.cos(r) * 40} y1={c.y + Math.sin(r) * 40} x2={c.x + Math.cos(r) * 40} y2={c.y - Math.sin(r) * 40} stroke="var(--brand)" strokeWidth={3} markerEnd="url(#arr)" />
              <text x={c.x} y={c.y + 22} fontSize={10} textAnchor="middle" fill="var(--brand)">boards</text>
            </g>;
          })()}
          <defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--brand)" /></marker></defs>
        </svg>
        <div className="tools">
          <button className={`btn small ${tool === 'select' ? 'on' : ''}`} onClick={() => { setTool('select'); setDraft([]); }}>☝︎ Select</button>
          <button className="btn small" onClick={() => setAddOpen('rect')}>▭ Rectangle</button>
          <button className="btn small" onClick={() => setAddOpen('tri')}>◺ Triangle</button>
          <button className={`btn small ${tool === 'poly' ? 'on' : ''}`} onClick={() => { setTool('poly'); setDraft([]); }}>✎ Draw outline</button>
          <button className="btn small" onClick={() => setAddOpen('arc')}>◠ Curve</button>
          <button className={`btn small ${tool === 'cutout' ? 'on' : ''}`} onClick={() => { setTool('cutout'); setDraft([]); }}>⊘ Cutout</button>
          <button className="btn small" onClick={doUndo} disabled={!undo.length} aria-label="Undo">↶</button>
          <button className="btn small" onClick={doRedo} disabled={!redo.length} aria-label="Redo">↷</button>
          <button className="btn small" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.25)} aria-label="Zoom in">＋</button>
          <button className="btn small" onClick={() => zoomAt(size.w / 2, size.h / 2, 0.8)} aria-label="Zoom out">－</button>
          <button className="btn small" onClick={fit}>Fit</button>
          {draft.length >= 3 && <button className="btn small on" onClick={finishPoly}>Close shape</button>}
        </div>
        <div className="hud">
          <span className="pill">{geo.valid ? fmtSqFt(geo.areaSqIn) : 'No valid area'}</span>
          {geo.valid && <span className="pill">Perimeter {formatFtIn(geo.perimeterIn)}</span>}
          {geometry.areaOverride && <span className="pill orange">Area override {geometry.areaOverride.value} sq ft</span>}
          {(tool === 'poly' || tool === 'cutout') && <span className="pill blue">Tap to add corners (6" grid) · tap first corner to close</span>}
          <span className="pill" style={{ marginLeft: 'auto' }}><span className="dot" style={{ color: TAG_COLORS.house }} />House <span className="dot" style={{ color: '#8b5a2b' }} />Ledger <span className="dot" style={{ color: 'var(--accent)' }} />Rail <span className="dot" style={{ color: '#c45d00' }} />Fascia</span>
        </div>
      </div>

      {geo.issues.filter((i) => i.severity !== 'info').map((i) => <div key={i.id} className={`issue ${i.severity}`}><span className="ico">!</span>{i.message}</div>)}

      {/* Inspector */}
      <div className="card">
        {selShape ? (
          <ShapeInspector shape={selShape} cutout={!!sel?.kind && (sel as any).cutout} onPatch={(p) => updateShape(selShape.id, p, (sel as any).cutout)} onDelete={() => removeShape(selShape.id, (sel as any).cutout)} />
        ) : selSource ? (
          <EdgeInspector edgeKey={selSource.key} length={selSource.length} tag={geometry.edgeTags[selSource.key] ?? { side: 'open' }} openings={geometry.openings.filter((o) => o.edgeKey === selSource.key)}
            onTag={(p) => setTag(selSource.key, p)}
            onOpenings={(list) => commit({ ...geometry, openings: [...geometry.openings.filter((o) => o.edgeKey !== selSource.key), ...list] })} />
        ) : (
          <div className="col">
            <h3>Areas</h3>
            {geometry.shapes.length === 0 && <div className="sub">Start with a rectangle — type the measured length and width — then add more areas, a triangle, a curve, or draw any outline.</div>}
            <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}>
              {geo.perShape.map((p) => (
                <button key={p.id} className="item" onClick={() => setSel({ kind: 'shape', id: p.id })}>
                  <div style={{ flex: 1 }}><b>{p.label}</b><div className="small">{p.formula}{p.accuracy ? ` · ${p.accuracy}` : ''}</div></div>
                  <span>{fmtSqFt(p.areaSqIn)}</span>
                </button>
              ))}
            </div>
            {geo.valid && geo.grossShapeAreaSqIn - geo.areaSqIn > 1 && <div className="small">Overlaps removed: {fmtSqFt(geo.grossShapeAreaSqIn - geo.areaSqIn)} (areas are unioned, never double-counted).</div>}
            <div className="row">
              <button className="btn primary" onClick={() => setAddOpen('rect')}>＋ Add rectangle</button>
              <button className="btn" onClick={onOverride}>Override area…</button>
            </div>
            <div className="small">Tap any outline edge to mark it as the house wall/ledger, railing, fascia, or to add a gate or stair opening.</div>
          </div>
        )}
      </div>

      <AddShapeSheet open={addOpen} onClose={() => setAddOpen(null)} origin={nextOrigin()} count={geometry.shapes.length} onAdd={addShape} />
    </div>
  );
}

function ShapeInspector({ shape: s, cutout, onPatch, onDelete }: { shape: Shape; cutout: boolean; onPatch: (p: Partial<Shape>) => void; onDelete: () => void }) {
  return (
    <div className="col">
      <div className="row"><input className="input" style={{ maxWidth: 260, fontWeight: 600 }} value={s.label} onChange={(e) => onPatch({ label: e.target.value })} /><span className="pill">{cutout ? 'Cutout' : s.kind}</span><div className="spacer" /><button className="btn danger small" onClick={onDelete}>Delete</button></div>
      <div className="grid">
        {s.kind === 'rect' && <>
          <Field label="Length (along house, x)"><LengthInput value={s.w} onChange={(v) => v && onPatch({ w: v } as any)} /></Field>
          <Field label="Width (out from house, y)"><LengthInput value={s.h} onChange={(v) => v && onPatch({ h: v } as any)} /></Field>
        </>}
        {s.kind === 'triangle' && <>
          <Field label="Base"><LengthInput value={s.base} onChange={(v) => v && onPatch({ base: v } as any)} /></Field>
          <Field label="Perpendicular height"><LengthInput value={s.height} onChange={(v) => v && onPatch({ height: v } as any)} /></Field>
          <Field label="Apex offset from base start"><LengthInput value={s.apexOffset} onChange={(v) => v !== undefined && onPatch({ apexOffset: v } as any)} /></Field>
          <Field label="Direction"><Segmented value={s.flip ? 'down' : 'up'} options={[{ value: 'up', label: 'Away from house' }, { value: 'down', label: 'Toward house' }]} onChange={(v) => onPatch({ flip: v === 'down' } as any)} /></Field>
        </>}
        {s.kind === 'arc' && <>
          <Field label="Chord length"><LengthInput value={Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y)} onChange={(v) => v && onPatch({ p2: { x: s.p1.x + v, y: s.p1.y } } as any)} /></Field>
          <Field label="Bulge depth (sagitta)"><LengthInput value={Math.abs(s.sagitta)} onChange={(v) => v && onPatch({ sagitta: Math.sign(s.sagitta || 1) * v } as any)} /></Field>
          <Field label="Segments (accuracy)"><NumberInput value={s.segments} onChange={(v) => v && v >= 2 && onPatch({ segments: Math.round(v) } as any)} /></Field>
          <div className="small" style={{ alignSelf: 'end' }}>{arcAccuracy(s).label}</div>
        </>}
        {s.kind !== 'polygon' && s.kind !== 'arc' && <>
          <Field label="Position x"><LengthInput value={(s as any).x} onChange={(v) => v !== undefined && onPatch({ x: v } as any)} /></Field>
          <Field label="Position y"><LengthInput value={(s as any).y} onChange={(v) => v !== undefined && onPatch({ y: v } as any)} /></Field>
        </>}
        {!cutout && <Field label="Deck height above grade" hint="Finished surface; used for posts, stairs and guards"><LengthInput value={s.heightIn} onChange={(v) => onPatch({ heightIn: v })} /></Field>}
      </div>
      {s.kind === 'polygon' && (
        <div className="col" style={{ gap: 6 }}>
          <div className="label">Corners (x, y)</div>
          {s.points.map((p, i) => (
            <div key={i} className="row" style={{ gap: 8 }}>
              <span className="pill">{i + 1}</span>
              <div style={{ width: 150 }}><LengthInput value={p.x} onChange={(v) => v !== undefined && onPatch({ points: s.points.map((q, j) => (j === i ? { ...q, x: v } : q)) } as any)} /></div>
              <div style={{ width: 150 }}><LengthInput value={p.y} onChange={(v) => v !== undefined && onPatch({ points: s.points.map((q, j) => (j === i ? { ...q, y: v } : q)) } as any)} /></div>
              {s.points.length > 3 && <button className="btn small danger" onClick={() => onPatch({ points: s.points.filter((_, j) => j !== i) } as any)}>Remove</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EdgeInspector({ edgeKey, length, tag, openings, onTag, onOpenings }: { edgeKey: string; length: number; tag: EdgeTag; openings: Opening[]; onTag: (p: Partial<EdgeTag>) => void; onOpenings: (o: Opening[]) => void }) {
  return (
    <div className="col">
      <div className="row"><h3 style={{ margin: 0 }}>Edge {edgeKey}</h3><span className="pill">{formatFtIn(length)}</span></div>
      <Segmented value={tag.side} options={[{ value: 'open', label: 'Exposed edge' }, { value: 'house', label: 'House wall' }]} onChange={(v) => onTag({ side: v })} />
      <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}>
        {tag.side === 'house' ? (
          <label className="item"><div style={{ flex: 1 }}>Ledger attaches here<div className="small">Joists hang from a ledger on this wall</div></div><span className="switch"><input type="checkbox" checked={!!tag.ledger} onChange={(e) => onTag({ ledger: e.target.checked })} /><span /></span></label>
        ) : <>
          <label className="item"><div style={{ flex: 1 }}>Railing required</div><span className="switch"><input type="checkbox" checked={!!tag.rail} onChange={(e) => onTag({ rail: e.target.checked })} /><span /></span></label>
          <label className="item"><div style={{ flex: 1 }}>Fascia</div><span className="switch"><input type="checkbox" checked={!!tag.fascia} onChange={(e) => onTag({ fascia: e.target.checked })} /><span /></span></label>
          <label className="item"><div style={{ flex: 1 }}>Skirting</div><span className="switch"><input type="checkbox" checked={!!tag.skirting} onChange={(e) => onTag({ skirting: e.target.checked })} /><span /></span></label>
        </>}
      </div>
      {tag.side === 'open' && <>
        <div className="label">Openings on this edge (measured from the edge start)</div>
        {openings.map((o) => (
          <div key={o.id} className="row" style={{ gap: 8 }}>
            <span className={`pill ${o.kind === 'gate' ? 'green' : 'blue'}`}>{o.kind === 'gate' ? 'Gate' : 'Stairs'}</span>
            <div style={{ width: 140 }}><LengthInput value={o.offsetIn} onChange={(v) => v !== undefined && onOpenings(openings.map((x) => (x.id === o.id ? { ...x, offsetIn: v } : x)))} /></div>
            <span className="small">width</span>
            <div style={{ width: 140 }}><LengthInput value={o.widthIn} onChange={(v) => v && onOpenings(openings.map((x) => (x.id === o.id ? { ...x, widthIn: v } : x)))} /></div>
            <button className="btn small danger" onClick={() => onOpenings(openings.filter((x) => x.id !== o.id))}>Remove</button>
          </div>
        ))}
        <div className="row">
          <button className="btn small" onClick={() => onOpenings([...openings, { id: `g${uid().slice(0, 5)}`, kind: 'gate', edgeKey, offsetIn: Math.max(0, length / 2 - 18), widthIn: 36 }])}>＋ Gate opening</button>
          <button className="btn small" onClick={() => onOpenings([...openings, { id: `s${uid().slice(0, 5)}`, kind: 'stair', edgeKey, offsetIn: Math.max(0, length / 2 - 24), widthIn: 48 }])}>＋ Stair opening</button>
        </div>
      </>}
    </div>
  );
}

function AddShapeSheet({ open, onClose, origin, count, onAdd }: { open: null | 'rect' | 'tri' | 'arc'; onClose: () => void; origin: Pt; count: number; onAdd: (s: Shape) => void }) {
  const [a, setA] = useState<number | undefined>(192);
  const [b, setB] = useState<number | undefined>(144);
  const [c, setC] = useState<number | undefined>(undefined);
  const [place, setPlace] = useState<'right' | 'origin'>('right');
  useEffect(() => { if (open) { setA(open === 'arc' ? 144 : 192); setB(open === 'arc' ? 36 : open === 'tri' ? 72 : 144); setC(undefined); setPlace(count ? 'right' : 'origin'); } }, [open]);
  if (!open) return null;
  const o = place === 'right' && count ? origin : { x: 0, y: 0 };
  const id = uid().slice(0, 6);
  const label = `Area ${count + 1}`;
  const make = (): Shape | null => {
    if (!a || !b) return null;
    if (open === 'rect') return { id, label, kind: 'rect', x: o.x, y: o.y, w: a, h: b };
    if (open === 'tri') return { id, label, kind: 'triangle', x: o.x, y: o.y, base: a, height: b, apexOffset: c ?? a / 2 };
    return { id, label, kind: 'arc', p1: { x: o.x, y: o.y }, p2: { x: o.x + a, y: o.y }, sagitta: b, segments: 24 };
  };
  const titles = { rect: 'Add rectangle', tri: 'Add triangle', arc: 'Add curved section' };
  return (
    <Sheet open title={titles[open]} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!make()} onClick={() => { const s = make(); if (s) onAdd(s); }}>Add</button></>}>
      <div className="grid two">
        <Field label={open === 'rect' ? 'Length (along house)' : open === 'tri' ? 'Base' : 'Chord (straight side)'}><LengthInput value={a} onChange={setA} /></Field>
        <Field label={open === 'rect' ? 'Width (out from house)' : open === 'tri' ? 'Perpendicular height' : 'Bulge depth'}><LengthInput value={b} onChange={setB} /></Field>
        {open === 'tri' && <Field label="Apex offset (blank = centered)"><LengthInput value={c} onChange={setC} /></Field>}
      </div>
      {open === 'rect' && a && b && <div className="small" style={{ marginTop: 10 }}>{formatFtIn(a)} × {formatFtIn(b)} = <b>{fmtSqFt(a * b)}</b> before waste (length × width)</div>}
      {open === 'arc' && <div className="small" style={{ marginTop: 10 }}>Curves are approximated with 24 straight chords; accuracy is shown on the area.</div>}
      {count > 0 && <div style={{ marginTop: 14 }}><Segmented value={place} options={[{ value: 'right', label: 'Attach to the right of the deck' }, { value: 'origin', label: 'Place at origin' }]} onChange={setPlace} /></div>}
      <div className="small" style={{ marginTop: 10 }}>You can drag areas on the sketch; corners snap to neighbouring corners so shared edges line up exactly.</div>
    </Sheet>
  );
}
