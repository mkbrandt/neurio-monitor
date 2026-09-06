// Talks to a Neurio/Generac energy sensor's local HTTP API (no auth, LAN only).
// GET http://<sensor-ip>/current-sample returns a JSON sample with a
// "channels" array. Newer sensors (with solar) report several overlapping
// channels - e.g. PHASE_A_CONSUMPTION + PHASE_B_CONSUMPTION sum to
// CONSUMPTION, and NET = CONSUMPTION - GENERATION - so channels can't just
// be summed blindly or power gets double-counted.

async function fetchCurrentSample(ip) {
  const res = await fetch(`http://${ip}/current-sample`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Neurio sensor returned HTTP ${res.status}`);
  }
  return res.json();
}

function channelPower(ch) {
  const p = ch.p_W ?? ch.p ?? ch.power ?? ch.avgPower ?? ch.watts;
  return typeof p === 'number' ? p : undefined;
}

function findChannel(channels, type) {
  return channels.find((ch) => ch.type === type);
}

// Returns { consumption, generation, net } in watts (any of which may be
// null if the sensor doesn't report it). generation = solar production,
// net = grid draw (negative = exporting). consumption = total home usage -
// whatever the house drew from the grid *plus* whatever it used from solar,
// computed explicitly as net + generation rather than trusting the
// sensor's own "CONSUMPTION" channel, which isn't guaranteed to already
// combine both sources (it can reflect grid-side/billing consumption only).
function extractPowerBreakdown(sample) {
  const channels = sample.channels || sample.channelList || [];

  let generation = channelPower(findChannel(channels, 'GENERATION') || {});
  let net = channelPower(findChannel(channels, 'NET') || {});
  let consumption;

  if (net === undefined) {
    // No grid-tie/solar metering on this sensor - fall back to whatever it
    // calls consumption directly, since net + generation isn't computable.
    consumption = channelPower(findChannel(channels, 'CONSUMPTION') || {});
    if (consumption === undefined) {
      const phaseChannels = channels.filter(
        (ch) => typeof ch.type === 'string' && ch.type.endsWith('_CONSUMPTION')
      );
      if (phaseChannels.length > 0) {
        consumption = phaseChannels.reduce((sum, ch) => sum + (channelPower(ch) || 0), 0);
      } else if (channels.length > 0) {
        // Older/simpler sensors with no channel typing beyond a single CT set.
        consumption = channels.reduce((sum, ch) => sum + (channelPower(ch) || 0), 0);
      }
    }
  } else {
    consumption = net + (generation || 0);
  }

  if (generation === undefined) generation = 0;

  return {
    consumption: typeof consumption === 'number' ? consumption : null,
    generation: typeof generation === 'number' ? generation : null,
    net: typeof net === 'number' ? net : null,
  };
}

module.exports = { fetchCurrentSample, extractPowerBreakdown };
