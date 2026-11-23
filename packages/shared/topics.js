// MQTT topic layout shared by edge, ingest, simulator and api.
//
//   sff/{farm}/{pond}/telemetry   pond DO probe: do, do_pct, temp (QoS 1)
//   sff/{farm}/{unit}/ras/telemetry  RAS probes of a unit: ph, orp, temp (QoS 1)
//   sff/{farm}/{pond}/state       actual device state from PLC feedback (retained)
//   sff/{farm}/{pond}/cmd         commands to PLC (NOT retained, carries id + expires_at)
//   sff/{farm}/{pond}/cmd/ack     command result from PLC
//   sff/{farm}/gateway/status     gateway online/offline (retained, LWT)
//   sff/{farm}/alarm              alarms raised at the edge

export const ROOT = 'sff';

export const topics = {
  telemetry: (farm, pond) => `${ROOT}/${farm}/${pond}/telemetry`,
  rasTelemetry: (farm, unit) => `${ROOT}/${farm}/${unit}/ras/telemetry`,
  state: (farm, pond) => `${ROOT}/${farm}/${pond}/state`,
  cmd: (farm, pond) => `${ROOT}/${farm}/${pond}/cmd`,
  cmdAck: (farm, pond) => `${ROOT}/${farm}/${pond}/cmd/ack`,
  gatewayStatus: (farm) => `${ROOT}/${farm}/gateway/status`,
  alarm: (farm) => `${ROOT}/${farm}/alarm`,
};

export const INGEST_SUBSCRIPTIONS = [
  `${ROOT}/+/+/telemetry`,
  `${ROOT}/+/+/ras/telemetry`,
  `${ROOT}/+/+/state`,
  `${ROOT}/+/+/cmd/ack`,
  `${ROOT}/+/gateway/status`,
  `${ROOT}/+/alarm`,
];

/** @returns {{kind: string, farm: string, pond?: string, unit?: string} | null} */
export function parseTopic(topic) {
  const parts = topic.split('/');
  if (parts[0] !== ROOT || parts.length < 3) return null;
  const [, farm, a, b, c] = parts;
  if (parts.length === 3 && a === 'alarm') return { kind: 'alarm', farm };
  if (parts.length === 4 && a === 'gateway' && b === 'status') return { kind: 'gateway', farm };
  if (parts.length === 4 && (b === 'telemetry' || b === 'state' || b === 'cmd')) {
    return { kind: b, farm, pond: a };
  }
  if (parts.length === 5 && b === 'ras' && c === 'telemetry') return { kind: 'rasTelemetry', farm, unit: a };
  if (parts.length === 5 && b === 'cmd' && c === 'ack') return { kind: 'cmdAck', farm, pond: a };
  return null;
}
