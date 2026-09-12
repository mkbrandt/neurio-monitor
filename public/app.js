let activeMinutes = 60;
let latestAlwaysOnW = null;

async function refreshCurrent() {
  try {
    const res = await fetch('/api/current');
    const data = await res.json();
    const subEl = document.getElementById('stat-sub');
    const netLineEl = document.getElementById('net-line');

    if (data.ts === null) {
      document.getElementById('stat-consumption').textContent = '–';
      document.getElementById('stat-generation').textContent = '–';
      subEl.textContent = 'Waiting for first reading…';
      netLineEl.textContent = '';
      return;
    }

    document.getElementById('stat-consumption').textContent = formatWatts(data.consumption);
    document.getElementById('stat-generation').textContent = formatWatts(data.generation);

    netLineEl.classList.remove('net-import', 'net-export');
    if (typeof data.net === 'number') {
      if (data.net > 0) {
        netLineEl.classList.add('net-import');
        netLineEl.textContent = `Importing ${formatWatts(data.net)} from grid`;
      } else if (data.net < 0) {
        netLineEl.classList.add('net-export');
        netLineEl.textContent = `Exporting ${formatWatts(-data.net)} to grid`;
      } else {
        netLineEl.textContent = 'Balanced with grid';
      }
    } else {
      netLineEl.textContent = '';
    }

    latestAlwaysOnW = typeof data.alwaysOnW === 'number' ? data.alwaysOnW : null;
    updateAlwaysOnCard();

    const seconds = Math.round((Date.now() - data.ts) / 1000);
    subEl.textContent = seconds < 5 ? 'as of just now' : seconds < 60 ? `as of ${seconds}s ago` : `as of ${Math.round(seconds / 60)}m ago`;
  } catch (err) {
    document.getElementById('stat-sub').textContent = 'Unable to reach server';
  }
}

function updateAlwaysOnCard() {
  const valueEl = document.getElementById('always-on-value');
  const markerEl = document.getElementById('always-on-marker');
  if (latestAlwaysOnW === null) {
    valueEl.textContent = '–';
    return;
  }
  valueEl.textContent = formatWatts(latestAlwaysOnW);
  const maxLabelEl = document.getElementById('always-on-max-label');
  const scaleMax = Number(maxLabelEl.dataset.scaleMax) || Math.max(200, latestAlwaysOnW * 2);
  const pct = Math.max(0, Math.min(100, (latestAlwaysOnW / scaleMax) * 100));
  markerEl.style.left = `${pct}%`;
}

async function refreshAlwaysOnScale() {
  try {
    const res = await fetch('/api/day?offset=0');
    const data = await res.json();
    const scaleMax = Math.max(200, Math.round(data.stats.consumption.max || 200));
    const maxLabelEl = document.getElementById('always-on-max-label');
    maxLabelEl.textContent = formatWatts(scaleMax);
    maxLabelEl.dataset.scaleMax = String(scaleMax);
    updateAlwaysOnCard();
  } catch (err) {
    // leave default scale
  }
}

async function refreshHistory() {
  const svg = document.getElementById('chart');
  const emptyEl = document.getElementById('chart-empty');
  try {
    const res = await fetch(`/api/history?minutes=${activeMinutes}`);
    const rows = await res.json();

    const series = [
      {
        cls: 'consumption',
        label: 'Consumption',
        points: rows.filter((r) => typeof r.consumption === 'number').map((r) => ({ ts: r.ts, value: r.consumption })),
      },
      {
        cls: 'generation',
        label: 'Generation',
        points: rows.filter((r) => typeof r.generation === 'number').map((r) => ({ ts: r.ts, value: r.generation })),
      },
    ];

    if (latestAlwaysOnW !== null && rows.length > 0) {
      const minTs = rows[0].ts;
      const maxTs = rows[rows.length - 1].ts;
      series.push({
        cls: 'always-on',
        label: 'Always On',
        dashed: true,
        points: [
          { ts: minTs, value: latestAlwaysOnW },
          { ts: maxTs, value: latestAlwaysOnW },
        ],
      });
    }

    const layout = renderTimeSeriesChart(svg, series, { width: 800, height: 300, emptyEl });
    const tooltip = document.getElementById('tooltip');
    setupCrosshair(svg, layout, svg.parentElement, tooltip);
  } catch (err) {
    renderTimeSeriesChart(svg, [], { emptyEl });
  }
}

// Solar production as a percentage of consumption - unlike "used from solar"
// this isn't capped at 100%, since a home can generate more than it
// consumes (net exporting).
function solarRatioPct(consumptionKwh, generationKwh) {
  return consumptionKwh > 0 ? (generationKwh / consumptionKwh) * 100 : generationKwh > 0 ? Infinity : 0;
}

// Traces an Archimedean spiral clockwise from 12 o'clock: each full 360°
// revolution corresponds to 100%, and the radius shrinks a little every
// revolution, so 100%, 200%, etc. are unmistakable as distinct inward loops
// rather than a ring that's merely "more filled in". Sampled as a polyline
// (SVG has no native spiral) at a fixed angular resolution, so the point
// count - and rendering cost - scales with the percentage, not a fixed cap.
function spiralPath(cx, cy, outerR, minR, pitchPerLap, percent) {
  if (!(percent > 0)) return '';
  const DEGREES_PER_SAMPLE = 4;
  const samples = Math.max(2, Math.round((percent * 3.6) / DEGREES_PER_SAMPLE));
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const pct = (i / samples) * percent;
    const angleRad = ((-90 + pct * 3.6) * Math.PI) / 180;
    const r = Math.max(minR, outerR - pitchPerLap * (pct / 100));
    points.push(`${(cx + r * Math.cos(angleRad)).toFixed(2)} ${(cy + r * Math.sin(angleRad)).toFixed(2)}`);
  }
  return `M ${points.join(' L ')}`;
}

async function refreshEnergySummary() {
  try {
    const res = await fetch('/api/energy-summary');
    const data = await res.json();

    document.getElementById('solar-period-label').textContent = data.label;

    // A single net grid figure rather than separate "exported"/"imported"
    // totals - those are both always-accumulating one-directional sums, so
    // side by side they read as gross production/draw rather than what
    // actually crossed the meter net over the period. Net > 0 means more
    // was drawn from the grid than sent to it this period; net < 0 means
    // the reverse - the label follows whichever actually happened.
    const netGridKwh = data.importedKwh - data.exportedKwh;
    const netLabelEl = document.getElementById('grid-net-label');
    const netValueEl = document.getElementById('grid-net-value');
    netLabelEl.textContent = netGridKwh >= 0 ? 'Imported from Grid' : 'Exported to Grid';
    netValueEl.textContent = formatKwh(Math.abs(netGridKwh));
    netLabelEl.classList.toggle('solar-stat-exported-label', netGridKwh < 0);
    netValueEl.classList.toggle('solar-stat-exported-value', netGridKwh < 0);
    netLabelEl.classList.toggle('stat-consumption', netGridKwh >= 0);
    netValueEl.classList.toggle('stat-consumption', netGridKwh >= 0);

    // Gross exported energy's dollar value, at whatever buyback rate is
    // configured - independent of the net figure above, since a home can
    // export plenty during the day and still be a net importer overall.
    const buybackEl = document.getElementById('grid-buyback');
    if (typeof data.gridBuybackUsd === 'number') {
      buybackEl.hidden = false;
      buybackEl.textContent = `Buyback $${data.gridBuybackUsd.toFixed(2)}`;
    } else {
      buybackEl.hidden = true;
    }

    document.getElementById('solar-used').textContent = formatKwh(data.usedFromSolarKwh);
    document.getElementById('total-consumption').textContent = formatKwh(data.consumptionKwh);
    document.getElementById('total-generation').textContent = formatKwh(data.generationKwh);

    const savedEl = document.getElementById('gauge-saved');
    if (typeof data.costSavedUsd === 'number') {
      savedEl.hidden = false;
      savedEl.textContent = `Saved $${data.costSavedUsd.toFixed(2)}`;
    } else {
      savedEl.hidden = true;
    }

    const fixedCostEl = document.getElementById('fixed-cost-line');
    if (typeof data.fixedCostUsd === 'number') {
      fixedCostEl.hidden = false;
      fixedCostEl.textContent = `Fixed Cost: $${data.fixedCostUsd.toFixed(2)} (flat, this period)`;
    } else {
      fixedCostEl.hidden = true;
    }

    const ratio = solarRatioPct(data.consumptionKwh, data.generationKwh);
    document.getElementById('gauge-value').textContent = Number.isFinite(ratio) ? `${Math.round(ratio)}%` : '∞%';

    const gaugeSvg = document.getElementById('gauge');
    const cx = 80, cy = 80, outerR = 68, minR = 4, pitchPerLap = 16, strokeW = 10;
    const displayPercent = Number.isFinite(ratio) ? ratio : 500;
    gaugeSvg.innerHTML = `
      <circle class="gauge-ring-track" cx="${cx}" cy="${cy}" r="${outerR}" stroke-width="${strokeW}"></circle>
      <path class="gauge-spiral-value" d="${spiralPath(cx, cy, outerR, minR, pitchPerLap, displayPercent)}"
        stroke-width="${strokeW}" fill="none"></path>
    `;
  } catch (err) {
    document.getElementById('gauge-value').textContent = '–';
  }
}

async function refreshEnergyByDay() {
  try {
    const res = await fetch('/api/energy-by-day?days=7');
    const rows = await res.json();
    const buckets = rows.map((r) => ({
      label: new Date(r.date + 'T12:00:00').toLocaleDateString([], { weekday: 'narrow' }),
      consumptionKwh: r.consumptionKwh,
      generationKwh: r.generationKwh,
    }));
    const layout = renderKwhBarChart(document.getElementById('bar-chart'), buckets, { width: 700, height: 240 });
    setupBarHover(document.getElementById('bar-chart'), layout, document.getElementById('bar-chart').parentElement, document.getElementById('bar-tooltip'));

    const totalConsumption = rows.reduce((sum, r) => sum + r.consumptionKwh, 0);
    const totalGeneration = rows.reduce((sum, r) => sum + r.generationKwh, 0);
    const net = totalConsumption - totalGeneration;
    // Labeled by direction rather than signed, matching the Solar Savings
    // card's net-grid stat - "-5.2 kWh" reads as an error at a glance,
    // "Net Export 5.2 kWh" doesn't need the reader to know the sign
    // convention.
    document.getElementById('gain-label').textContent = net > 0 ? 'Net Import' : net < 0 ? 'Net Export' : 'Net';
    const gainEl = document.getElementById('gain-kwh');
    gainEl.textContent = formatKwh(Math.abs(net));
    gainEl.classList.remove('net-import', 'net-export');
    gainEl.classList.add(net > 0 ? 'net-import' : net < 0 ? 'net-export' : '');
  } catch (err) {
    document.getElementById('gain-kwh').textContent = '–';
  }
}

let currentInterval = null;
let historyInterval = null;

// The live display (current-power stats + chart) updates every second while
// the 10-minute window is selected, so it actually feels live at that
// zoom level; otherwise the normal, less chatty cadence is plenty.
function scheduleLiveRefresh() {
  clearInterval(currentInterval);
  clearInterval(historyInterval);
  const live = activeMinutes === 10;
  currentInterval = setInterval(refreshCurrent, live ? 1000 : 5000);
  historyInterval = setInterval(refreshHistory, live ? 1000 : 30000);
}

document.getElementById('range-filter').addEventListener('click', (evt) => {
  const btn = evt.target.closest('.range-btn');
  if (!btn) return;
  document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  activeMinutes = Number(btn.dataset.minutes);
  refreshHistory();
  scheduleLiveRefresh();
});

refreshCurrent().then(refreshHistory);
refreshAlwaysOnScale();
refreshEnergySummary();
refreshEnergyByDay();

scheduleLiveRefresh();
setInterval(refreshAlwaysOnScale, 60000);
setInterval(refreshEnergySummary, 60000);
setInterval(refreshEnergyByDay, 60000);
