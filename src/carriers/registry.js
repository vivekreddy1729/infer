import config from '../config.js';
import MockCarrier from './mockCarrier.js';
import ProgressiveCarrier from './progressive.js';
import GeicoCarrier from './geico/index.js';

/**
 * Carrier registry.
 *
 * Adding a carrier is: implement BaseCarrier, import it, add it to the list.
 * The dropdown, validation, session keying and orchestration all read from here,
 * so there is exactly one place to touch.
 *
 * This file is the ONLY place the GEICO and Progressive adapters meet. They share
 * no code by design — see the isolation contract in `./geico/selectors.js`. The
 * orchestrator drives both polymorphically through `BaseCarrier`, so neither
 * adapter can affect the other's behaviour.
 *
 * Note on ordering: adding a carrier that declares a `prewarm` block means the
 * warm-page pool parks one of its login pages at boot. With two real carriers
 * registered that is two background page loads per process start, which is
 * proportionate — but it is the reason replenishment stays demand-driven rather
 * than on a timer (see OPTIMISATION-LOG O-10).
 */

const ALL = [ProgressiveCarrier, GeicoCarrier, MockCarrier];

/** Real-carrier adapters are appended here as they are implemented. */
const enabled = ALL.filter((C) => {
  if (C.id === 'demo') return config.ENABLE_MOCK_CARRIER;
  return true;
});

export const carriers = new Map(enabled.map((C) => [C.id, C]));

export function getCarrier(id) {
  return carriers.get(id) ?? null;
}

/** Shape consumed by the frontend dropdown. */
export function listCarriers() {
  return [...carriers.values()].map((C) => ({
    id: C.id,
    displayName: C.displayName,
    supportsSessionReuse: C.supportsSessionReuse,
    requiresProxy: C.usesProxy,
    isDemo: C.id === 'demo',
  }));
}

export default { carriers, getCarrier, listCarriers };
