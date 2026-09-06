// Turns stored instantaneous-power samples (watts) into energy totals (kWh)
// via trapezoidal integration - there's no separate energy-metering hardware,
// so this is derived entirely from the same readings the dashboard already
// stores.

function integrateKwh(samples, key) {
  let wattHours = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1][key];
    const b = samples[i][key];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const dtHours = (samples[i].ts - samples[i - 1].ts) / 3600000;
    wattHours += ((a + b) / 2) * dtHours;
  }
  return wattHours / 1000;
}

// Splits generation into "used directly by the home" vs "exported to the
// grid", and consumption not covered by solar into "imported from grid",
// by integrating the per-sample min/max of consumption and generation.
function integrateSolarSplit(samples) {
  let usedFromSolarWh = 0;
  let exportedWh = 0;
  let importedWh = 0;

  for (let i = 1; i < samples.length; i++) {
    const c0 = samples[i - 1].consumption_w;
    const c1 = samples[i].consumption_w;
    const g0 = samples[i - 1].generation_w;
    const g1 = samples[i].generation_w;
    if (typeof c0 !== 'number' || typeof c1 !== 'number') continue;
    if (typeof g0 !== 'number' || typeof g1 !== 'number') continue;

    const dtHours = (samples[i].ts - samples[i - 1].ts) / 3600000;
    const avgC = (c0 + c1) / 2;
    const avgG = (g0 + g1) / 2;

    usedFromSolarWh += Math.min(avgC, avgG) * dtHours;
    exportedWh += Math.max(0, avgG - avgC) * dtHours;
    importedWh += Math.max(0, avgC - avgG) * dtHours;
  }

  return {
    usedFromSolarKwh: usedFromSolarWh / 1000,
    exportedKwh: exportedWh / 1000,
    importedKwh: importedWh / 1000,
  };
}

module.exports = { integrateKwh, integrateSolarSplit };
