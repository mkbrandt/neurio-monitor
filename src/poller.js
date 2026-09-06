const { fetchCurrentSample, extractPowerBreakdown } = require('./neurio');
const { insertReading } = require('./db');

let loggedSampleShape = false;

async function pollOnce(ip) {
  const sample = await fetchCurrentSample(ip);

  if (!loggedSampleShape) {
    console.log('Sample received from Neurio sensor:', JSON.stringify(sample));
    loggedSampleShape = true;
  }

  const { consumption, generation, net } = extractPowerBreakdown(sample);
  insertReading({ ts: Date.now(), consumption, generation, net, raw: sample });
  return { consumption, generation, net };
}

function startPolling(ip, intervalMs) {
  const tick = () => {
    pollOnce(ip)
      .then(({ consumption }) => {
        if (consumption === null) {
          console.warn('Could not find a power reading in the sensor sample.');
        }
      })
      .catch((err) => {
        console.error(`Failed to poll Neurio sensor at ${ip}:`, err.message);
      });
  };

  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { startPolling, pollOnce };
