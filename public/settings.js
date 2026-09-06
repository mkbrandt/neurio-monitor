async function loadSettings() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  document.getElementById('billing-start-day').value = settings.billingCycleStartDay;
  document.getElementById('electricity-rate').value =
    typeof settings.electricityRateUsdPerKwh === 'number' ? settings.electricityRateUsdPerKwh : '';
}

document.getElementById('settings-form').addEventListener('submit', async (evt) => {
  evt.preventDefault();
  const statusEl = document.getElementById('settings-status');
  const rateInput = document.getElementById('electricity-rate').value.trim();

  const body = {
    billingCycleStartDay: Number(document.getElementById('billing-start-day').value),
    electricityRateUsdPerKwh: rateInput === '' ? null : Number(rateInput),
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
