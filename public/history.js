let granularity = 'hour';
let offsets = { hour: 0, day: 0, month: 0, billing: 0 };

const UNIT_LABEL = { hour: 'Hour', day: 'Day', month: 'Month', billing: 'Day' };

function bucketLabel(ts, gran) {
  const d = new Date(ts);
  if (gran === 'hour') return formatHour12(ts);
  if (gran === 'day') return String(d.getDate());
  if (gran === 'billing') return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
  return MONTH_ABBR[d.getMonth()];
}

function statOrDash(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? formatKwh(value) : '–';
}

function formatUsd(value) {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

async function loadPeriod() {
  const svg = document.getElementById('chart');
  const emptyEl = document.getElementById('chart-empty');
  const nextBtn = document.getElementById('next-period');
  const offset = offsets[granularity];

  try {
    const res = await fetch(`/api/history-buckets?granularity=${granularity}&offset=${offset}`);
    const data = await res.json();

    document.getElementById('period-label').textContent = data.label;
    nextBtn.disabled = !data.canGoForward;

    const costEl = document.getElementById('cost-line');
    if (granularity === 'billing' && typeof data.projectedCostUsd === 'number') {
      costEl.hidden = false;
      costEl.textContent = `Projected Cost: ${formatUsd(data.projectedCostUsd)}`;
    } else {
      costEl.hidden = true;
    }

    const buckets = data.buckets.map((b) => ({
      label: bucketLabel(b.ts, granularity),
      consumptionKwh: b.consumptionKwh,
      generationKwh: b.generationKwh,
      costUsd: b.costUsd,
    }));

    const layout = renderKwhBarChart(svg, buckets, { width: 900, height: 300, maxLabels: 12, emptyEl });
    setupBarHover(svg, layout, svg.parentElement, document.getElementById('tooltip'));

    const unit = UNIT_LABEL[granularity];
    document.getElementById('c-max-label').textContent = `Highest ${unit}`;
    document.getElementById('c-min-label').textContent = `Lowest ${unit}`;
    document.getElementById('g-max-label').textContent = `Highest ${unit}`;
    document.getElementById('g-min-label').textContent = `Lowest ${unit}`;
    document.getElementById('n-max-label').textContent = `Highest ${unit}`;
    document.getElementById('n-min-label').textContent = `Lowest ${unit}`;

    document.getElementById('c-max').textContent = statOrDash(data.stats.consumption.max);
    document.getElementById('c-min').textContent = statOrDash(data.stats.consumption.min);
    document.getElementById('c-avg').textContent = statOrDash(data.stats.consumption.avg);
    document.getElementById('g-max').textContent = statOrDash(data.stats.generation.max);
    document.getElementById('g-min').textContent = statOrDash(data.stats.generation.min);
    document.getElementById('g-avg').textContent = statOrDash(data.stats.generation.avg);

    const totalConsumption = data.buckets.reduce((sum, b) => sum + b.consumptionKwh, 0);
    const totalGeneration = data.buckets.reduce((sum, b) => sum + b.generationKwh, 0);
    document.getElementById('c-total').textContent = statOrDash(totalConsumption);
    document.getElementById('g-total').textContent = statOrDash(totalGeneration);

    // Net = consumption - generation, positive meaning that bucket/period was
    // a net grid import and negative a net export - same convention as the
    // dashboard's net-grid figure. Each net cell carries its own direction
    // rather than a shared label, since the highest, lowest, average and
    // total can each land on a different side of zero.
    const setNetCell = (id, value) => {
      const el = document.getElementById(id);
      el.classList.remove('net-import', 'net-export');
      if (typeof value !== 'number' || Number.isNaN(value)) {
        el.textContent = '–';
        return;
      }
      const direction = value > 0 ? 'Imp' : value < 0 ? 'Exp' : '';
      el.textContent = `${formatKwh(Math.abs(value))}${direction ? ' ' + direction : ''}`;
      if (value > 0) el.classList.add('net-import');
      else if (value < 0) el.classList.add('net-export');
    };

    setNetCell('n-max', data.stats.net.max);
    setNetCell('n-min', data.stats.net.min);
    setNetCell('n-avg', data.stats.net.avg);
    setNetCell('n-total', totalConsumption - totalGeneration);
  } catch (err) {
    renderKwhBarChart(svg, [], { emptyEl });
  }
}

document.getElementById('granularity-tabs').addEventListener('click', (evt) => {
  const btn = evt.target.closest('.range-btn');
  if (!btn) return;
  document.querySelectorAll('#granularity-tabs .range-btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  granularity = btn.dataset.granularity;
  loadPeriod();
});

document.getElementById('prev-period').addEventListener('click', () => {
  offsets[granularity] += 1;
  loadPeriod();
});

document.getElementById('next-period').addEventListener('click', () => {
  if (offsets[granularity] > 0) {
    offsets[granularity] -= 1;
    loadPeriod();
  }
});

loadPeriod();
