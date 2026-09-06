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

function solarShares(consumptionKwh, generationKwh) {
  if (!(consumptionKwh > 0)) {
    return generationKwh > 0 ? { solar: 100, grid: 0 } : { solar: 0, grid: 0 };
  }
  const solar = Math.min(100, (Math.min(consumptionKwh, generationKwh) / consumptionKwh) * 100);
  return { solar, grid: 100 - solar };
}

function ringDash(radius, pct) {
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * circumference;
  return `${filled.toFixed(2)} ${circumference.toFixed(2)}`;
}

async function refreshEnergySummary() {
  try {
    const res = await fetch('/api/energy-summary?days=30');
    const data = await res.json();

    document.getElementById('solar-exported').textContent = formatKwh(data.exportedKwh);
    document.getElementById('solar-used').textContent = formatKwh(data.usedFromSolarKwh);
    document.getElementById('gauge-value').textContent = `${Math.round(data.percentFromSolar)}%`;

    const savedEl = document.getElementById('gauge-saved');
    if (typeof data.costSavedUsd === 'number') {
      savedEl.hidden = false;
      savedEl.textContent = `Saved $${data.costSavedUsd.toFixed(2)}`;
    } else {
      savedEl.hidden = true;
    }

    const shares = solarShares(data.consumptionKwh, data.generationKwh);
    const gaugeSvg = document.getElementById('gauge');
    const cx = 80, cy = 80, outerR = 64, innerR = 46, strokeW = 14;
    const outerArc = shares.solar > 0.5
      ? `<circle class="gauge-ring-value ring-outer" cx="${cx}" cy="${cy}" r="${outerR}" stroke-width="${strokeW}"
          stroke-dasharray="${ringDash(outerR, shares.solar)}" transform="rotate(-90 ${cx} ${cy})"></circle>`
      : '';
    const innerArc = shares.grid > 0.5
      ? `<circle class="gauge-ring-value ring-inner" cx="${cx}" cy="${cy}" r="${innerR}" stroke-width="${strokeW}"
          stroke-dasharray="${ringDash(innerR, shares.grid)}" transform="rotate(-90 ${cx} ${cy})"></circle>`
      : '';
    gaugeSvg.innerHTML = `
      <circle class="gauge-ring-track" cx="${cx}" cy="${cy}" r="${outerR}" stroke-width="${strokeW}"></circle>
      <circle class="gauge-ring-track" cx="${cx}" cy="${cy}" r="${innerR}" stroke-width="${strokeW}"></circle>
      ${outerArc}
      ${innerArc}
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
    const gainEl = document.getElementById('gain-kwh');
    gainEl.textContent = `${net > 0 ? '+' : net < 0 ? '-' : ''}${formatKwh(Math.abs(net))}`;
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
