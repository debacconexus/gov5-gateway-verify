'use strict';
// ECOS (Environmental Certification & Oversight Standard): the one ECOS block every DeBacco Nexus receipt carries.
// Same standard, coefficients and sources as Oshi (airs-studio server.cjs, ECOS_STANDARD 'ECOS-2026.4'), so a receipt
// from the gateway, the gate or Oshi reads the same way for every customer, AE4RIA included.
// Every figure is a declared modelled estimate from provider-measured tokens and published coefficients, not a meter reading.
const axios = require('axios');

const VERSION = process.env.ECOS_STANDARD_VERSION || 'ECOS-2026.4';
// Energy: Jegham et al. 2025 (Claude 3.7 Sonnet per-query energy at three sizes), fitted to J per input token,
// J per output token and J per model call. Haiku 0.1x and Opus 4x Sonnet. Cached input counted at the full input rate.
const SPLIT = { input: 0.58, output: 9.256, perCall: 174.6 };
const TIER = { haiku: 0.1, sonnet: 1, opus: 4 };
// Grid by the region set when a customer is activated
const GRIDS = {
  NL: { code: 'NL', name: 'Netherlands (Amsterdam)', kgPerKwh: 0.2622, source: 'Electricity Maps, Grid Review 2025: the Netherlands, 262.2 gCO2eq/kWh (flow-traced)', url: 'https://www.electricitymaps.com/grid-in-review-2025/the-netherlands', graceRegion: 'Northwest Europe' },
  CAMX: { code: 'CAMX', name: 'WECC California (CAMX)', kgPerKwh: +(436.7 * 0.45359237 / 1000).toFixed(4), source: 'U.S. EPA eGRID2023, CAMX total output CO2 rate (436.7 lb/MWh)', url: 'https://www.epa.gov/egrid/summary-data', graceRegion: 'Southern California' },
  US: { code: 'US', name: 'U.S. national average', kgPerKwh: +(771.5 * 0.45359237 / 1000).toFixed(4), source: 'U.S. EPA eGRID2023, U.S. total output CO2 rate (771.5 lb/MWh)', url: 'https://www.epa.gov/egrid/summary-data', graceRegion: 'Global' }
};
const DEFAULT_REGION = GRIDS[String(process.env.ECOS_REGION || 'CAMX').toUpperCase()] ? String(process.env.ECOS_REGION || 'CAMX').toUpperCase() : 'CAMX';
// Water: LBNL 2024, 17 billion gallons direct over 176 TWh (2023); indirect about 12x direct
const WATER_DIRECT_L = +(17e9 * 3.78541 / 176e9).toFixed(4);
const WATER_ML_PER_KWH = +((WATER_DIRECT_L + WATER_DIRECT_L * 12) * 1000).toFixed(1);
// Human cost: EPA 2023 social cost of carbon, USD 190 per metric ton CO2
const SCC_USD_PER_T = parseFloat(process.env.ECOS_SOCIAL_COST_USD_PER_TON || '190');
// Anthropic list prices, USD per million tokens (same table as Oshi), for reference only; the provider's bill is the authority
const PRICING = {
  haiku: { input: 1, output: 5 }, sonnet: { input: 3, output: 15 }, opus: { input: 5, output: 25 },
  opus5: { input: 4, output: 20 }, sonnet5: { input: 2, output: 10 }
};
// NASA GRACE-FO regional water storage, cm equivalent water thickness (published regional table, same as Oshi)
const GRACE = { 'Southern California': -4.2, 'Northwest Europe': 0.3, 'Global': -0.5 };
const SOURCES = [
  { what: 'Energy per input token, output token and call', source: 'Jegham et al. 2025, How Hungry is AI? Benchmarking Energy, Water, and Carbon Footprint of LLM Inference', url: 'https://arxiv.org/html/2505.09598v1' },
  { what: 'Grid carbon intensity', source: 'U.S. EPA eGRID2023; Electricity Maps Grid Review 2025 (Netherlands)', url: 'https://www.epa.gov/egrid/summary-data' },
  { what: 'Water per kWh', source: 'LBNL, 2024 United States Data Center Energy Usage Report', url: 'https://eta-publications.lbl.gov/publications/2024-lbnl-data-center-energy-usage-report' },
  { what: 'Human cost of carbon', source: 'U.S. EPA, Report on the Social Cost of Greenhouse Gases (Nov 2023), USD 190 per ton', url: 'https://eelp.law.harvard.edu/tracker/the-social-cost-of-carbon/' },
  { what: 'Atmospheric CO2, live monthly', source: 'NOAA Global Monitoring Laboratory, Mauna Loa', url: 'https://gml.noaa.gov/ccgg/trends/' },
  { what: 'Terrestrial water storage', source: 'NASA GRACE-FO mascon solution, JPL RL06.1', url: 'https://science.nasa.gov/eyes/' },
  { what: 'Framing: green and digital transitions reinforce each other', source: 'Koundouri, Landis et al. (2023), Twin Skills for the Twin Transition, AE4RIA, ATHENA Research Centre', url: null }
];
const DISCLOSURE = 'Declared modelled estimates from provider-measured tokens and published coefficients, not hardware meter readings. NASA and NOAA observations give place context; they did not measure this inference.';

// ---------- live planetary context (NOAA monthly CO2), refreshed every 6 hours ----------
let noaa = { ppm: 425.8, period: '2025-09', dataset: 'NOAA GML Mauna Loa monthly mean CO2', retrieval: 'published value (live fetch not yet available)' };
async function refreshNoaa() {
  try {
    const r = await axios.get('https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt', { timeout: 10000, responseType: 'text' });
    const rows = String(r.data).split('\n').filter(l => l && l[0] !== '#').map(l => l.trim().split(/\s+/));
    for (let i = rows.length - 1; i >= 0; i--) {
      const avg = parseFloat(rows[i][3]);
      if (avg > 0) { noaa = { ppm: avg, period: rows[i][0] + '-' + ('0' + rows[i][1]).slice(-2), dataset: 'NOAA GML Mauna Loa monthly mean CO2 (co2_mm_mlo)', retrieval: 'live', retrievedAt: new Date().toISOString() }; return; }
    }
  } catch (e) { /* keep the last value; its retrieval label says which it is */ }
}
if (!process.env.ECOS_NO_LIVE) { setTimeout(refreshNoaa, 2000).unref(); setInterval(refreshNoaa, 6 * 3600 * 1000).unref(); }

const tierOf = model => { const m = String(model || '').toLowerCase(); return m.indexOf('haiku') > -1 ? 'haiku' : m.indexOf('opus') > -1 ? 'opus' : 'sonnet'; };
const isClaude = model => /claude|haiku|sonnet|opus/i.test(String(model || ''));
function listPriceUSD(model, input, output) {
  if (!isClaude(model)) return null;
  const m = String(model).toLowerCase();
  const p = m.indexOf('opus-5') > -1 ? PRICING.opus5 : m.indexOf('sonnet-5') > -1 ? PRICING.sonnet5 : m.indexOf('haiku') > -1 ? PRICING.haiku : m.indexOf('opus') > -1 ? PRICING.opus : PRICING.sonnet;
  return (input * p.input + output * p.output) / 1e6;
}
const regions = () => Object.values(GRIDS).map(g => ({ code: g.code, name: g.name, kgPerKwh: g.kgPerKwh, source: g.source }));
const regionOf = code => GRIDS[String(code || DEFAULT_REGION).toUpperCase()] || GRIDS[DEFAULT_REGION];

// stages: [{ stage, model, input, output, calls }]; no stages or no calls means no model ran (0 J)
function compute(stages, regionCode) {
  const g = regionOf(regionCode);
  const rows = (stages || []).filter(s => s && ((s.calls || 0) > 0 || (s.input || 0) + (s.output || 0) > 0)).map(s => {
    const tier = tierOf(s.model), sc = TIER[tier], calls = s.calls == null ? 1 : s.calls, input = s.input || 0, output = s.output || 0;
    const energy = sc * (input * SPLIT.input + output * SPLIT.output + calls * SPLIT.perCall);
    const usd = listPriceUSD(s.model, input, output);
    return { stage: s.stage || 'model', model: s.model || null, tier, calls, input, output, energy_j: +energy.toFixed(4),
      coefficients: (TIER[tier] !== 1 ? TIER[tier] + 'x Sonnet: ' : 'Sonnet class: ') + +(sc * SPLIT.input).toFixed(3) + ' J/input token, ' + +(sc * SPLIT.output).toFixed(3) + ' J/output token, ' + +(sc * SPLIT.perCall).toFixed(1) + ' J/call' + (isClaude(s.model) ? '' : ' (no published per-model figure for this provider; Sonnet-class coefficients applied)'),
      listPriceUsd: usd == null ? null : +usd.toFixed(6) };
  });
  const ej = rows.reduce((a, r) => a + r.energy_j, 0), kwh = ej / 3.6e6, co2 = kwh * g.kgPerKwh * 1000, water = kwh * WATER_ML_PER_KWH;
  const human = co2 * SCC_USD_PER_T / 1e6, prices = rows.map(r => r.listPriceUsd);
  const vitals = [
    ['Terrestrial Water Storage', water, 'mL water', 'DIRECT', 'GRACE-FO (NASA/JPL)'], ['Soil Moisture', water, 'mL water', 'DIRECT', 'SMAP (NASA)'],
    ['Precipitation', water, 'mL water', 'CASCADE', 'GPM (NASA/JAXA)'], ['Atmospheric CO2', co2, 'g CO2', 'DIRECT', 'OCO-2/3 (NASA/JPL)'],
    ['Sea Surface Temperature', co2, 'g CO2', 'CASCADE', 'MODIS/Aqua (NASA)'], ['Sea Level', co2, 'g CO2', 'CASCADE', 'Jason-3 / Sentinel-6 (NASA/NOAA/ESA)'],
    ['Ice Sheets', co2, 'g CO2', 'CASCADE', 'ICESat-2 (NASA)'], ['Chlorophyll', co2, 'g CO2', 'SYSTEMIC', 'MODIS / VIIRS (NASA/NOAA)'],
    ['Ozone / N2O', ej / 3600, 'Wh grid energy', 'SYSTEMIC', 'Aura/OMI (NASA)']
  ].map(v => ({ vital: v[0], amount: +v[1].toFixed(6), unit: v[2], tier: v[3], monitoredBy: v[4] }));
  return {
    standard: VERSION, modelRan: rows.length > 0,
    region: { code: g.code, name: g.name, gridKgCo2PerKwh: g.kgPerKwh, gridSource: g.source },
    stages: rows, tokens: { input: rows.reduce((a, r) => a + r.input, 0), output: rows.reduce((a, r) => a + r.output, 0), source: 'provider-reported usage' },
    governed: { energy_j: +ej.toFixed(4), energy_wh: +(ej / 3600).toFixed(6), co2_g: +co2.toFixed(6), water_ml: +water.toFixed(6), human_usd: +human.toFixed(8) },
    listPriceUsd: prices.length && prices.every(p => p != null) ? +prices.reduce((a, p) => a + p, 0).toFixed(6) : null,
    ungoverned: { applies: false, reason: 'No governed-versus-ungoverned saving is claimed on this receipt. A saving is shown only where it was measured.' },
    nasaVitals: vitals,
    planet: { noaaCo2: Object.assign({}, noaa), graceFo: GRACE[g.graceRegion] == null ? null : { region: g.graceRegion, waterStorageCmEWT: GRACE[g.graceRegion], dataset: 'NASA GRACE-FO mascon solution, JPL RL06.1', period: '2024-2025 regional mean', retrieval: 'published regional table' } },
    constants: { waterMlPerKwh: WATER_ML_PER_KWH, socialCostUsdPerTonCo2: SCC_USD_PER_T },
    sources: SOURCES, disclosure: DISCLOSURE,
    note: rows.length ? null : 'No model ran for this request, so it used no model energy.'
  };
}

module.exports = { VERSION, compute, regions, regionOf, DEFAULT_REGION, SOURCES, DISCLOSURE, tierOf };
