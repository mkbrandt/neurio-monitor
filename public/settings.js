async function loadSettings() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  document.getElementById('billing-start-day').value = settings.billingCycleStartDay;
  document.getElementById('electricity-rate').value =
    typeof settings.electricityRateUsdPerKwh === 'number' ? settings.electricityRateUsdPerKwh : '';
  document.getElementById('grid-buyback-rate').value =
    typeof settings.gridBuybackRateUsdPerKwh === 'number' ? settings.gridBuybackRateUsdPerKwh : '';
  document.getElementById('fixed-cost').value =
    typeof settings.fixedCostPerBillingPeriodUsd === 'number' ? settings.fixedCostPerBillingPeriodUsd : '';
}

document.getElementById('settings-form').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const statusEl = document.getElementById('settings-status');
  const rateInput = document.getElementById('electricity-rate').value.trim();
  const buybackRateInput = document.getElementById('grid-buyback-rate').value.trim();
  const fixedCostInput = document.getElementById('fixed-cost').value.trim();

  const body = {
    billingCycleStartDay: Number(document.getElementById('billing-start-day').value),
    electricityRateUsdPerKwh: rateInput === '' ? null : Number(rateInput),
    gridBuybackRateUsdPerKwh: buybackRateInput === '' ? null : Number(buybackRateInput),
    fixedCostPerBillingPeriodUsd: fixedCostInput === '' ? null : Number(fixedCostInput),
  };

  statusEl.textContent = 'Saving…';
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed');
    }
    statusEl.textContent = 'Saved.';
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

loadSettings();
