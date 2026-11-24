// Alarm state machine (no I/O, unit-tested).
//
// Each tick the alerter turns live data into observations {key, level, hold, clearHold, ...ctx}
// where level is 'ok' | 'warn' | 'crit'. A problem must persist `hold` seconds before an alarm
// opens (no alarm for a one-sample spike), and must be normal for `clearHold` seconds before it
// clears (no flapping). An open warn alarm is raised to crit once crit itself has held.
//
// Keys with no observation this tick are frozen (e.g. pond offline alarms while the whole
// gateway is down) - the caller sends level 'ok' explicitly when something should clear.

export class AlarmEngine {
  constructor() {
    /** key -> {abnormalSince, critSince, normalSince, open: {id, severity} | null} */
    this.state = new Map();
  }

  /** Seed from alarms already open in the DB (alerter restart): they stay open, no re-notify. */
  restore(openAlarms, now) {
    for (const a of openAlarms) {
      this.state.set(a.key, {
        abnormalSince: now,
        critSince: a.severity === 'crit' ? now : null,
        normalSince: null,
        open: { id: a.id, severity: a.severity },
      });
    }
  }

  /**
   * @param {Array<{key: string, level: 'ok'|'warn'|'crit', hold: number, clearHold: number}>} observations
   * @param {number} now epoch ms
   * @returns {Array<{op: 'open'|'raise'|'clear', key: string, severity?: string, obs: object, alarmId?: number}>}
   */
  step(observations, now) {
    const actions = [];
    for (const obs of observations) {
      let st = this.state.get(obs.key);
      if (!st) {
        if (obs.level === 'ok') continue; // nothing to track
        st = { abnormalSince: null, critSince: null, normalSince: null, open: null };
        this.state.set(obs.key, st);
      }

      if (obs.level === 'ok') {
        st.abnormalSince = null;
        st.critSince = null;
        st.normalSince ??= now;
      } else {
        st.normalSince = null;
        st.abnormalSince ??= now;
        if (obs.level === 'crit') st.critSince ??= now;
        else st.critSince = null;
      }

      const held = (since, sec) => since != null && now - since >= sec * 1000;

      if (!st.open) {
        if (held(st.abnormalSince, obs.hold)) {
          const severity = held(st.critSince, obs.hold) ? 'crit' : 'warn';
          actions.push({ op: 'open', key: obs.key, severity, obs });
        } else if (obs.level === 'ok') {
          this.state.delete(obs.key); // recovered before the hold ran out
        }
        continue;
      }

      if (held(st.normalSince, obs.clearHold)) {
        actions.push({ op: 'clear', key: obs.key, alarmId: st.open.id, obs });
      } else if (st.open.severity === 'warn' && held(st.critSince, obs.hold)) {
        actions.push({ op: 'raise', key: obs.key, severity: 'crit', alarmId: st.open.id, obs });
      }
    }
    return actions;
  }

  /** Record the outcome of an action once it is stored. */
  applied(action, alarmId) {
    const st = this.state.get(action.key);
    if (!st) return;
    if (action.op === 'open') st.open = alarmId ? { id: alarmId, severity: action.severity } : st.open;
    else if (action.op === 'raise') st.open.severity = 'crit';
    else if (action.op === 'clear') this.state.delete(action.key);
  }

  /** Alarm closed outside the engine (e.g. acknowledged lab result, deleted pond). */
  forget(key) {
    this.state.delete(key);
  }
}

/**
 * Which open, unacknowledged alarms need another push now.
 * crit: repeat every `critRepeatSec` until someone acknowledges (escalation_level counts repeats).
 * warn: escalate once to managers after `warnEscalateSec`.
 * @returns {Array<{alarm: object, reason: 'renotify'|'escalate', roles: string[]}>}
 */
export function dueEscalations(openAlarms, now, { critRepeatSec = 300, warnEscalateSec = 1800 } = {}) {
  const out = [];
  for (const a of openAlarms) {
    if (a.acked_at || a.cleared_at) continue;
    const last = new Date(a.last_notified_at ?? a.started_at).getTime();
    if (a.severity === 'crit' && now - last >= critRepeatSec * 1000) {
      out.push({ alarm: a, reason: 'renotify', roles: RECIPIENTS.crit });
    } else if (a.severity === 'warn' && a.escalation_level === 0 && now - new Date(a.started_at).getTime() >= warnEscalateSec * 1000) {
      out.push({ alarm: a, reason: 'escalate', roles: RECIPIENTS.escalate });
    }
  }
  return out;
}

// Who gets a push. Everyone on shift must hear about a crit; warnings go to technicians and up.
export const RECIPIENTS = {
  crit: ['worker', 'technician', 'manager', 'owner'],
  warn: ['technician', 'manager', 'owner'],
  escalate: ['manager', 'owner'],
};
