const path = require('path');
const fs = require('fs');

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
const defaults = {
  billingCycleStartDay: 1,
  electricityRateUsdPerKwh: null,
  gridBuybackRateUsdPerKwh: null,
  fixedCostPerBillingPeriodUsd: null,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch (err) {
    return { ...defaults };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

module.exports = { loadSettings, saveSettings };
