/**
 * Units. Every length in the engine is stored in INCHES (number). Areas are
 * computed in square inches and converted to square feet only for display and
 * pricing. Fractional inches are kept exactly as typed (1/16" resolution is the
 * finest input the UI offers; the engine does not round internally).
 */

export const IN_PER_FT = 12;
export const SQIN_PER_SQFT = 144;
export const CUIN_PER_CUFT = 1728;

export const ft = (feet: number, inches = 0): number => feet * IN_PER_FT + inches;
export const toFeet = (inches: number): number => inches / IN_PER_FT;
export const sqInToSqFt = (sqIn: number): number => sqIn / SQIN_PER_SQFT;
export const cuInToCuFt = (cuIn: number): number => cuIn / CUIN_PER_CUFT;

/** Round to avoid binary-float noise in displayed results (not used inside formulas). */
export const tidy = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Parse a field-entered length into inches.
 * Accepts: `16'`, `16 ft`, `16' 3"`, `16-3`, `16' 3 1/2"`, `3 1/2"`, `3.5in`,
 * `195.5` (bare number = inches unless `defaultUnit` = 'ft'), `16.25ft`.
 * Returns null for anything it cannot parse unambiguously.
 */
export function parseLength(input: string, defaultUnit: 'in' | 'ft' = 'in'): number | null {
  const s = input.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/\s+/g, ' ');
  if (!s) return null;

  const frac = (t: string): number | null => {
    // "3", "3.5", "1/2", "3 1/2"
    const m = t.trim().match(/^(\d+(?:\.\d+)?)?(?:\s*(\d+)\/(\d+))?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    let v = m[1] !== undefined ? parseFloat(m[1]) : 0;
    if (m[2] !== undefined) {
      const den = parseInt(m[3], 10);
      if (den === 0) return null;
      v += parseInt(m[2], 10) / den;
    }
    return v;
  };

  // feet + inches: 16' 3 1/2"  |  16ft 3in  |  16-3 1/2
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*-?\s*(.*?)\s*(?:"|in|inch|inches)?$/);
  if (m) {
    const feet = parseFloat(m[1]);
    const rest = m[2].trim();
    if (!rest) return feet * IN_PER_FT;
    const inches = frac(rest);
    return inches === null ? null : feet * IN_PER_FT + inches;
  }
  m = s.match(/^(\d+)-(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)$/);
  if (m) {
    const inches = frac(m[2]);
    return inches === null ? null : parseInt(m[1], 10) * IN_PER_FT + inches;
  }
  m = s.match(/^(.*?)\s*(?:"|in|inch|inches)$/);
  if (m) return frac(m[1]);
  const bare = frac(s);
  if (bare === null) return null;
  return defaultUnit === 'ft' ? bare * IN_PER_FT : bare;
}

/** Format inches as feet-inches with fractional sixteenths, e.g. 195.5 -> 16' 3 1/2". */
export function formatFtIn(inches: number, opts: { denom?: number } = {}): string {
  const denom = opts.denom ?? 16;
  const neg = inches < 0;
  let total = Math.round(Math.abs(inches) * denom); // in 1/denom inch
  const perFoot = IN_PER_FT * denom;
  const feet = Math.floor(total / perFoot);
  total -= feet * perFoot;
  const whole = Math.floor(total / denom);
  let num = total - whole * denom;
  let den = denom;
  while (num > 0 && num % 2 === 0 && den % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  const inchPart = num ? `${whole ? whole + ' ' : ''}${num}/${den}"` : `${whole}"`;
  const body = feet ? (whole || num ? `${feet}' ${inchPart}` : `${feet}'`) : inchPart;
  return (neg ? '-' : '') + body;
}

export const fmtSqFt = (sqIn: number): string => `${tidy(sqInToSqFt(sqIn), 2).toLocaleString('en-US')} sq ft`;
