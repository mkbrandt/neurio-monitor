const SVG_NS = 'http://www.w3.org/2000/svg';

function formatWatts(watts) {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return '–';
  if (Math.abs(watts) >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

function formatKwh(kwh) {
  if (kwh === null || kwh === undefined || Number.isNaN(kwh)) return '–';
  return `${kwh.toFixed(kwh < 10 ? 2 : 1)} kWh`;
}

function formatClock(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

function formatHour12(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}${ampm}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function niceStep(value) {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// series: [{ cls, label, points: [{ts, value}], area, dashed, dot }]
function renderTimeSeriesChart(svg, series, opts = {}) {
  const W = opts.width || 800;
  const H = opts.height || 300;
  const margin = opts.margin || { top: 12, right: 12, bottom: 24, left: 56 };
  const emptyEl = opts.emptyEl;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  const active = series.filter((s) => s.points.length > 0);
  if (active.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return null;
  }
  if (emptyEl) emptyEl.hidden = true;

  const allPoints = active.flatMap((s) => s.points);
  const minTs = opts.xMin ?? Math.min(...allPoints.map((p) => p.ts));
  const maxTs = opts.xMax ?? Math.max(...allPoints.map((p) => p.ts));
  const maxVal = Math.max(0, ...allPoints.map((p) => p.value));
  const minVal = Math.min(0, ...allPoints.map((p) => p.value));

  const yMax = niceStep(maxVal * 1.1 || 100);
  const yMin = minVal < 0 ? -niceStep(Math.abs(minVal) * 1.1) : 0;
  const yRange = yMax - yMin || 1;

  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const xScale = (ts) => (maxTs === minTs ? margin.left : margin.left + ((ts - minTs) / (maxTs - minTs)) * plotW);
  const yScale = (v) => margin.top + plotH - ((v - yMin) / yRange) * plotH;

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const value = yMin + (yRange / tickCount) * i;
    const y = yScale(value);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', W - margin.right);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', Math.abs(value) < 1e-6 ? 'axis-line' : 'grid-line');
    svg.appendChild(line);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', margin.left - 8);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'axis-label');
    label.textContent = opts.yTickFormat ? opts.yTickFormat(value) : formatWatts(value);
    svg.appendChild(label);
  }

  const xTickCount = opts.xTickCount || Math.min(5, allPoints.length);
  for (let i = 0; i < xTickCount; i++) {
    const ts = minTs + ((maxTs - minTs) / Math.max(xTickCount - 1, 1)) * i;
    const x = xScale(ts);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', H - 4);
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === xTickCount - 1 ? 'end' : 'middle');
    label.setAttribute('class', 'axis-label');
    label.textContent = opts.xTickFormat ? opts.xTickFormat(ts) : formatClock(ts);
    svg.appendChild(label);
  }

  for (const s of active) {
    if (s.area) {
      const zeroY = yScale(Math.min(Math.max(0, yMin), yMax));
      const areaData =
        `M ${xScale(s.points[0].ts).toFixed(1)} ${zeroY.toFixed(1)} ` +
        s.points.map((p) => `L ${xScale(p.ts).toFixed(1)} ${yScale(p.value).toFixed(1)}`).join(' ') +
        ` L ${xScale(s.points[s.points.length - 1].ts).toFixed(1)} ${zeroY.toFixed(1)} Z`;
      const area = document.createElementNS(SVG_NS, 'path');
      area.setAttribute('d', areaData);
      area.setAttribute('class', `series-area series-area-${s.cls}`);
      svg.appendChild(area);
    }

    const pathData = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.ts).toFixed(1)} ${yScale(p.value).toFixed(1)}`)
      .join(' ');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('class', `series-line series-line-${s.cls}${s.dashed ? ' series-line-dashed' : ''}`);
    svg.appendChild(path);

    if (s.dot !== false && !s.dashed) {
      const last = s.points[s.points.length - 1];
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', xScale(last.ts));
      dot.setAttribute('cy', yScale(last.value));
      dot.setAttribute('r', 4);
      dot.setAttribute('class', `series-dot-${s.cls}`);
      svg.appendChild(dot);
    }
  }

  return { xScale, yScale, minTs, maxTs, margin, W, H, active };
}

function setupCrosshair(svg, layout, chartWrap, tooltipEl) {
  if (!layout) return;
  const { xScale, minTs, maxTs, margin, W, H, active } = layout;

  const overlay = document.createElementNS(SVG_NS, 'rect');
  overlay.setAttribute('x', margin.left);
  overlay.setAttribute('y', margin.top);
  overlay.setAttribute('width', W - margin.left - margin.right);
  overlay.setAttribute('height', H - margin.top - margin.bottom);
  overlay.setAttribute('fill', 'transparent');
  svg.appendChild(overlay);

  const crosshair = document.createElementNS(SVG_NS, 'line');
  crosshair.setAttribute('class', 'crosshair-line');
  crosshair.setAttribute('y1', margin.top);
  crosshair.setAttribute('y2', H - margin.bottom);
  crosshair.style.display = 'none';
  svg.appendChild(crosshair);

  function nearestIndex(points, ts) {
    let closest = 0;
    let closestDist = Math.abs(points[0].ts - ts);
    for (let i = 1; i < points.length; i++) {
      const dist = Math.abs(points[i].ts - ts);
      if (dist < closestDist) {
        closest = i;
        closestDist = dist;
      }
    }
    return closest;
  }

  function showAt(clientX) {
    const rect = svg.getBoundingClientRect();
    const xFrac = (clientX - rect.left) / rect.width;
    const svgX = xFrac * W;
    const ts = minTs + ((svgX - margin.left) / (W - margin.left - margin.right)) * (maxTs - minTs);

    const reference = active[0];
    const idx = nearestIndex(reference.points, ts);
    const refPoint = reference.points[idx];
    const px = xScale(refPoint.ts);

    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.style.display = '';

    const parts = active.map((s) => {
      const p = s.points[Math.min(idx, s.points.length - 1)];
      return `${s.label}: ${formatWatts(p.value)}`;
    });

    const wrapRect = chartWrap.getBoundingClientRect();
    tooltipEl.hidden = false;
    tooltipEl.style.left = `${(px / W) * wrapRect.width}px`;
    tooltipEl.style.top = `${margin.top}px`;
    tooltipEl.innerHTML = `${formatClock(refPoint.ts)}<br>${parts.join('<br>')}`;
  }

  function hide() {
    crosshair.style.display = 'none';
    tooltipEl.hidden = true;
  }

  overlay.addEventListener('mousemove', (evt) => showAt(evt.clientX));
  overlay.addEventListener('mouseleave', hide);
  overlay.addEventListener('touchstart', (evt) => { evt.preventDefault(); showAt(evt.touches[0].clientX); }, { passive: false });
  overlay.addEventListener('touchmove', (evt) => { evt.preventDefault(); showAt(evt.touches[0].clientX); }, { passive: false });
  overlay.addEventListener('touchend', hide);
}

// buckets: [{ label, consumptionKwh, generationKwh }]
function renderKwhBarChart(svg, buckets, opts = {}) {
  const W = opts.width || 700;
  const H = opts.height || 260;
  const margin = opts.margin || { top: 12, right: 12, bottom: 28, left: 44 };
  const emptyEl = opts.emptyEl;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  if (buckets.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return null;
  }
  if (emptyEl) emptyEl.hidden = true;

  const values = buckets.flatMap((b) => [b.consumptionKwh, b.generationKwh]);
  const maxVal = niceStep(Math.max(0, ...values) * 1.1 || 1);
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const yScale = (v) => margin.top + plotH - (v / maxVal) * plotH;

  for (let i = 0; i <= 4; i++) {
    const value = (maxVal / 4) * i;
    const y = yScale(value);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', W - margin.right);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', i === 0 ? 'axis-line' : 'grid-line');
    svg.appendChild(line);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', margin.left - 6);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'axis-label');
    label.textContent = value === 0 ? '0' : value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : value.toFixed(0);
    svg.appendChild(label);
  }

  const band = plotW / buckets.length;
  const barWidth = Math.max(1, band * 0.32);
  const labelStride = Math.max(1, Math.ceil(buckets.length / (opts.maxLabels || 10)));
  const bars = [];

  buckets.forEach((b, i) => {
    const groupX = margin.left + i * band + band / 2;

    const cHeight = plotH - (yScale(b.consumptionKwh) - margin.top);
    const cBar = document.createElementNS(SVG_NS, 'rect');
    cBar.setAttribute('x', groupX - barWidth - 1);
    cBar.setAttribute('y', yScale(b.consumptionKwh));
    cBar.setAttribute('width', barWidth);
    cBar.setAttribute('height', Math.max(0, cHeight));
    cBar.setAttribute('class', 'bar-consumption');
    svg.appendChild(cBar);

    const gHeight = plotH - (yScale(b.generationKwh) - margin.top);
    const gBar = document.createElementNS(SVG_NS, 'rect');
    gBar.setAttribute('x', groupX + 1);
    gBar.setAttribute('y', yScale(b.generationKwh));
    gBar.setAttribute('width', barWidth);
    gBar.setAttribute('height', Math.max(0, gHeight));
    gBar.setAttribute('class', 'bar-generation');
    svg.appendChild(gBar);

    bars.push({ x: groupX, bucket: b });

    if (i % labelStride === 0 || i === buckets.length - 1) {
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', groupX);
      label.setAttribute('y', H - 6);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'axis-label');
      label.textContent = b.label;
      svg.appendChild(label);
    }
  });

  return { bars, margin, W, H };
}

function setupBarHover(svg, layout, chartWrap, tooltipEl) {
  if (!layout) return;
  const { bars, margin, W, H } = layout;

  const overlay = document.createElementNS(SVG_NS, 'rect');
  overlay.setAttribute('x', margin.left);
  overlay.setAttribute('y', margin.top);
  overlay.setAttribute('width', W - margin.left - margin.right);
  overlay.setAttribute('height', H - margin.top - margin.bottom);
  overlay.setAttribute('fill', 'transparent');
  svg.appendChild(overlay);

  function nearestBar(svgX) {
    let closest = bars[0];
    let closestDist = Math.abs(bars[0].x - svgX);
    for (const b of bars) {
      const dist = Math.abs(b.x - svgX);
      if (dist < closestDist) {
        closest = b;
        closestDist = dist;
      }
    }
    return closest;
  }

  function showAt(clientX) {
    const rect = svg.getBoundingClientRect();
    const xFrac = (clientX - rect.left) / rect.width;
    const svgX = xFrac * W;
    const bar = nearestBar(svgX);

    const wrapRect = chartWrap.getBoundingClientRect();
    tooltipEl.hidden = false;
    tooltipEl.style.left = `${(bar.x / W) * wrapRect.width}px`;
    tooltipEl.style.top = `${margin.top}px`;
    tooltipEl.innerHTML = `${bar.bucket.label}<br>Consumption: ${formatKwh(bar.bucket.consumptionKwh)}<br>Generation: ${formatKwh(bar.bucket.generationKwh)}`;
  }

  function hide() {
    tooltipEl.hidden = true;
  }

  overlay.addEventListener('mousemove', (evt) => showAt(evt.clientX));
  overlay.addEventListener('mouseleave', hide);
  overlay.addEventListener('touchstart', (evt) => { evt.preventDefault(); showAt(evt.touches[0].clientX); }, { passive: false });
  overlay.addEventListener('touchmove', (evt) => { evt.preventDefault(); showAt(evt.touches[0].clientX); }, { passive: false });
  overlay.addEventListener('touchend', hide);
}
