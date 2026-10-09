import type { EstimateDoc } from '../shared/types';

export function newEstimateDoc(): EstimateDoc {
  return {
    schemaVersion: 1,
    ui: { mode: 'consult', consultStep: 0, techStep: 0 },
    consult: {
      materials: { wood: false, composite: false },
      wood: {},
      compositeBrands: [],
      railing: {},
      gates: {},
      stairs: {},
      extras: { lighting: {} },
    },
    alternatives: [],
    geometry: { shapes: [], cutouts: [], edgeTags: {}, openings: [], joistAngleDeg: 90, deckingAngleDeg: 0 },
    structure: { ledger: { substrate: 'unknown' }, joist: { rimPlies: 1 }, beams: [] },
    footings: { support: 'unknown', spec: { shape: 'round' }, wastePct: 10 },
    decking: { pattern: 'straight', pictureFrameCourses: 0, kerfIn: 0.125, minReusableIn: 24, extraWastePct: 0 },
    stairs: [],
    demolition: { removeDecking: false, removeRails: false, removeFraming: false, removeFootings: false, disposal: 'unknown', allowances: [] },
    overrides: {},
    photos: [],
    aiSuggestions: [],
    pricing: { priceOverrides: {} },
  };
}

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
