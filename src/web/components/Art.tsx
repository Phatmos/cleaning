/**
 * Parametric illustrations used on consultation cards. These are generic
 * explanatory drawings (labelled as such), never product photos. Product
 * imagery comes only from the admin-managed asset catalog.
 */
import { useId } from 'react';

const BOARD = { wood: ['#c8915a', '#b97f47'], composite: ['#8a8f96', '#7a7f86'], frame: '#5b4636', frameComposite: '#4b5058' };

export type PlanShape = 'rectangle' | 'l-shape' | 'multi-area' | 'wraparound' | 'curved' | 'custom';

function shapePath(shape: PlanShape): string {
  switch (shape) {
    case 'l-shape': return 'M40 40 H280 V110 H170 V170 H40 Z';
    case 'multi-area': return 'M40 40 H180 V120 H40 Z M180 70 H290 V170 H180 Z';
    case 'wraparound': return 'M30 30 H290 V170 H220 V80 H100 V170 H30 Z';
    case 'curved': return 'M40 40 H280 V110 Q160 210 40 110 Z';
    case 'custom': return 'M40 60 L120 30 H280 V140 L210 175 H60 Z';
    default: return 'M40 40 H280 V165 H40 Z';
  }
}

export function PlanArt({ shape = 'rectangle', dir = 'h', frame = 0, material = 'composite', house = true, label }: { shape?: PlanShape; dir?: 'h' | 'v' | 'diag'; frame?: number; material?: 'wood' | 'composite'; house?: boolean; label?: string }) {
  const id = useId().replace(/:/g, '');
  const [a, b] = BOARD[material];
  const d = shapePath(shape);
  const lines: JSX.Element[] = [];
  const step = 9;
  if (dir === 'h') for (let y = 0; y < 220; y += step) lines.push(<rect key={y} x={0} y={y} width={340} height={step - 1.4} fill={(y / step) % 2 ? a : b} />);
  if (dir === 'v') for (let x = 0; x < 340; x += step) lines.push(<rect key={x} x={x} y={0} width={step - 1.4} height={220} fill={(x / step) % 2 ? a : b} />);
  if (dir === 'diag') for (let k = -220; k < 340; k += step * 1.3) lines.push(<line key={k} x1={k} y1={220} x2={k + 220} y2={0} stroke={Math.round(k / step) % 2 ? a : b} strokeWidth={step - 1} />);
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={label ?? 'Deck plan illustration'}>
      <rect width="320" height="200" fill="var(--bg-sunken)" />
      {house && <rect x="0" y="0" width="320" height="22" fill="var(--fill-strong)" />}
      {house && <text x="160" y="15" textAnchor="middle" fontSize="10" fill="var(--text-3)">HOUSE</text>}
      <defs><clipPath id={`c${id}`}><path d={d} fillRule="evenodd" /></clipPath></defs>
      <g clipPath={`url(#c${id})`}>
        <rect width="320" height="200" fill={b} />
        {lines}
      </g>
      {frame > 0 && <path d={d} fill="none" stroke={material === 'wood' ? BOARD.frame : BOARD.frameComposite} strokeWidth={frame * 16} clipPath={`url(#c${id})`} />}
      {frame > 1 && <path d={d} fill="none" stroke={b} strokeWidth={8} clipPath={`url(#c${id})`} strokeDasharray="0" opacity="0" />}
      <path d={d} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1.5" />
    </svg>
  );
}

export function ElevationArt({ fascia = true, rail = false, stairs = false, lights = false, skirting = false, under = 'none', pad = false, gate = false, covered = false, material = 'composite', railStyle = 'balusters', label }: {
  fascia?: boolean; rail?: boolean; stairs?: boolean; lights?: boolean; skirting?: boolean; under?: 'none' | 'drainage' | 'ceiling'; pad?: boolean; gate?: boolean; covered?: boolean; material?: 'wood' | 'composite'; railStyle?: 'balusters' | 'cable' | 'glass'; label?: string;
}) {
  const deckY = 90, deckH = 8, rimH = 20, groundY = 170;
  const [a] = BOARD[material];
  const fasciaCol = material === 'wood' ? '#a8733f' : '#5f646b';
  const posts = [70, 160, 250];
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={label ?? 'Deck side view illustration'}>
      <rect width="320" height="200" fill="var(--bg-sunken)" />
      <rect x="0" y={groundY} width="320" height={200 - groundY} fill="#7aa262" opacity="0.55" />
      <rect x="0" y="20" width="34" height={groundY - 20} fill="var(--fill-strong)" />
      <text x="17" y="60" fontSize="9" fill="var(--text-3)" textAnchor="middle" transform="rotate(-90 17 60)">HOUSE</text>
      {covered && <path d={`M34 26 L300 40 L300 46 L34 32 Z`} fill="#9aa0a6" />}
      {covered && <rect x="292" y="44" width="6" height={deckY - 44} fill="#8a8f96" />}
      {pad && <rect x="40" y={groundY - 3} width="250" height="6" fill="#bdbdbd" />}
      {under === 'drainage' && <path d={`M34 ${deckY + deckH + rimH + 6} H290`} stroke="#4a90d9" strokeWidth="3" strokeDasharray="6 4" />}
      {under === 'ceiling' && <rect x="34" y={deckY + deckH + rimH} width="256" height="5" fill="#e6e6e6" stroke="#bbb" />}
      {posts.map((x) => <rect key={x} x={x - 5} y={deckY + deckH + rimH} width="10" height={groundY - deckY - deckH - rimH} fill="#9b7a55" />)}
      {skirting && <g>{Array.from({ length: 26 }, (_, i) => <rect key={i} x={36 + i * 10} y={deckY + deckH + rimH} width="7" height={groundY - deckY - deckH - rimH} fill={fasciaCol} opacity="0.85" />)}</g>}
      <rect x="34" y={deckY} width="260" height={deckH} fill={a} />
      {fascia ? <rect x="34" y={deckY + deckH} width="260" height={rimH} fill={fasciaCol} /> : <g>
        <rect x="34" y={deckY + deckH} width="260" height={rimH} fill="#c9a77c" />
        {Array.from({ length: 16 }, (_, i) => <rect key={i} x={40 + i * 16} y={deckY + deckH + 2} width="4" height={rimH - 4} fill="#a3825a" />)}
      </g>}
      {rail && <g>
        <rect x="34" y={deckY - 44} width="260" height="5" fill="#2b2b2b" />
        <rect x="34" y={deckY - 6} width="260" height="3" fill="#2b2b2b" />
        {[40, 120, 200, 288].map((x) => <rect key={x} x={x - 4} y={deckY - 48} width="8" height="48" fill="#2b2b2b" />)}
        {railStyle === 'balusters' && Array.from({ length: 30 }, (_, i) => <rect key={i} x={48 + i * 8} y={deckY - 39} width="2" height="33" fill="#2b2b2b" />)}
        {railStyle === 'cable' && Array.from({ length: 6 }, (_, i) => <line key={i} x1="34" x2="294" y1={deckY - 36 + i * 5.5} y2={deckY - 36 + i * 5.5} stroke="#555" strokeWidth="1" />)}
        {railStyle === 'glass' && <rect x="44" y={deckY - 39} width="240" height="33" fill="#9fd3ff" opacity="0.35" />}
        {lights && [40, 120, 200, 288].map((x) => <circle key={x} cx={x} cy={deckY - 50} r="4" fill="#ffd60a" />)}
      </g>}
      {gate && <g><rect x="220" y={deckY - 40} width="40" height="36" fill="none" stroke="#2b2b2b" strokeWidth="3" /><line x1="220" y1={deckY - 40} x2="260" y2={deckY - 4} stroke="#2b2b2b" strokeWidth="2" /></g>}
      {stairs && <g>
        {Array.from({ length: 4 }, (_, i) => <rect key={i} x={294 + i * 0} y={deckY + deckH + rimH + i * 14} width={18 + i * 0} height="5" fill={a} transform={`translate(${i * 0} 0)`} />)}
        <path d={`M294 ${deckY + deckH} L318 ${groundY}`} stroke="#9b7a55" strokeWidth="5" />
        {lights && [0, 1, 2, 3].map((i) => <circle key={i} cx={303} cy={deckY + deckH + rimH + i * 14 + 8} r="2.5" fill="#ffd60a" />)}
      </g>}
    </svg>
  );
}

export function Swatch({ color, label }: { color?: string; label: string }) {
  const known: Record<string, string> = {};
  return (
    <div className="placeholder-art" style={color && known[color] ? { background: known[color] } : undefined}>
      <span style={{ fontSize: 28 }}>▦</span>
      <span>{label}</span>
      <span className="small">Image not added yet</span>
    </div>
  );
}
