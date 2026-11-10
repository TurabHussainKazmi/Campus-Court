'use strict';
// ============================================================================
// MYSTERY CARD 10 — FAIR RESOURCE SHARING
// ----------------------------------------------------------------------------
// Deterministic, explainable allocation of a limited resource. NO AI is used to
// invent scores. Every number below comes from a documented formula so the
// verdict can be reproduced and audited.
//
//   total = 0.40*urgency + 0.35*need + 0.25*fairness      (all terms on 1..10)
//
//   urgency   : student-provided 1..10 (clamped)
//   need      : bucketed from hours-until-deadline (sooner deadline -> higher)
//   fairness  : 10 minus a decaying penalty for recent access to THIS resource
//               (students who recently received it get lower priority)
//
// Higher total wins. Ties break by urgency, then earlier deadline, then roll.
// When the resource is time-divisible, the available window is split in
// proportion to totals (largest remainder to the top rank) instead of
// winner-takes-all. This is the opposite of first-come-first-served.
// ============================================================================
const { clamp } = require('./util');

const WEIGHTS = Object.freeze({ urgency: 0.40, need: 0.35, fairness: 0.25 });
const HISTORY_WINDOW_H = 168; // 7 days
const RECENT_PENALTY = 3;     // fairness points lost per (decayed) recent allocation

// Sooner deadline => greater actual need. Buckets are easy to explain to judges.
function needFromDeadline(hoursToDeadline) {
  const h = Math.max(0, Number(hoursToDeadline) || 0);
  if (h <= 6) return 10;
  if (h <= 24) return 8;
  if (h <= 48) return 6;
  if (h <= 72) return 4;
  if (h <= 168) return 2;
  return 1;
}

// Recent recipients are deprioritised. Each allocation in the last 7 days adds a
// penalty that decays linearly from 1 (just now) to 0 (7 days ago).
function fairnessFromHistory(allocations, roll, nowTs) {
  let weighted = 0;
  for (const a of allocations || []) {
    if (a.roll !== roll) continue;
    const ageH = (nowTs - a.at) / 3600000;
    if (ageH < 0 || ageH > HISTORY_WINDOW_H) continue;
    weighted += 1 - ageH / HISTORY_WINDOW_H;
  }
  return clamp(Math.round(10 - RECENT_PENALTY * weighted), 1, 10);
}

function scoreClaimant(claim, allocations, nowTs) {
  const urgency = clamp(Math.round(Number(claim.urgency) || 1), 1, 10);
  const hoursToDeadline = (Number(claim.deadline) - nowTs) / 3600000;
  const need = needFromDeadline(hoursToDeadline);
  const fairness = fairnessFromHistory(allocations, claim.roll, nowTs);
  const total = Math.round((WEIGHTS.urgency * urgency + WEIGHTS.need * need + WEIGHTS.fairness * fairness) * 100) / 100;
  return {
    roll: claim.roll, name: claim.name,
    resource: claim.resource || '', reason: claim.reason || '',
    deadline: Number(claim.deadline) || nowTs,
    hoursToDeadline: Math.round(hoursToDeadline * 10) / 10,
    urgency, need, fairness, total,
  };
}

function rank(scores) {
  return [...scores].sort((a, b) =>
    b.total - a.total ||
    b.urgency - a.urgency ||
    a.deadline - b.deadline ||
    String(a.roll).localeCompare(String(b.roll)));
}

function decisionLabel(allocation, row) {
  if (allocation.mode === 'time-share') {
    const slot = allocation.slots.find((s) => s.roll === row.roll);
    return slot && slot.minutes > 0 ? `Allocated ${slot.minutes} min` : 'Deferred — no time left';
  }
  return row.roll === allocation.winner ? 'Allocated (exclusive)' : 'Deferred — priority next round';
}

function explain(resourceName, ranked, allocation) {
  const top = ranked[0];
  const parts = [];
  parts.push(`Card 10 — Fair Resource Sharing for "${resourceName}".`);
  parts.push(`Each student is scored out of 10: urgency (40%), need from deadline (35%) and fairness history (25%).`);
  parts.push(`${top.name} leads with a total of ${top.total} (urgency ${top.urgency}, need ${top.need}, fairness ${top.fairness}).`);
  if (allocation.mode === 'time-share') {
    const split = allocation.slots.filter((s) => s.minutes > 0)
      .map((s) => `${s.name} ${s.minutes} min`).join(', ');
    parts.push(`The ${allocation.windowMinutes}-minute window is divided in proportion to scores: ${split}.`);
  } else {
    parts.push(`${allocation.winnerName} receives the resource now; the others keep priority for the next round.`);
  }
  const deprioritised = ranked.filter((r) => r.fairness < 10);
  if (deprioritised.length) {
    parts.push(`${deprioritised.map((r) => r.name).join(', ')} used this resource recently, so their fairness score was reduced to keep access rotating.`);
  }
  parts.push('Allocation is by score — never first-come-first-served.');
  return parts.join(' ');
}

// Main entry. Pure: given the same inputs it always returns the same result.
function computeAllocation({ resource, claimants, history = [], nowTs = Date.now(), timeSharing = false, windowMinutes = 0 }) {
  if (!Array.isArray(claimants) || claimants.length === 0) {
    throw new Error('At least one claimant is required');
  }
  const scores = claimants.map((c) => scoreClaimant(c, history, nowTs));
  const ranked = rank(scores);
  let allocation;
  if (timeSharing && windowMinutes > 0 && ranked.length > 1) {
    const sum = ranked.reduce((s, r) => s + r.total, 0) || 1;
    const slots = ranked.map((r) => ({ roll: r.roll, name: r.name, total: r.total, minutes: Math.floor(windowMinutes * r.total / sum) }));
    let remainder = windowMinutes - slots.reduce((s, r) => s + r.minutes, 0);
    for (let i = 0; remainder > 0; i = (i + 1) % slots.length) { slots[i].minutes++; remainder--; }
    allocation = { mode: 'time-share', windowMinutes, slots };
  } else {
    allocation = { mode: 'exclusive', winner: ranked[0].roll, winnerName: ranked[0].name };
  }
  const table = ranked.map((r, i) => ({ ...r, rank: i + 1, decision: decisionLabel(allocation, r) }));
  return {
    weights: WEIGHTS,
    historyWindowHours: HISTORY_WINDOW_H,
    table,
    allocation,
    explanation: explain(resource, ranked, allocation),
    resolvedAt: nowTs,
  };
}

// Build the history rows to persist after an allocation is decided.
function historyRecords(result, caseId, resourceName) {
  const at = result.resolvedAt;
  if (result.allocation.mode === 'time-share') {
    return result.allocation.slots.filter((s) => s.minutes > 0)
      .map((s) => ({ caseId, resource: resourceName, roll: s.roll, at, minutes: s.minutes }));
  }
  return [{ caseId, resource: resourceName, roll: result.allocation.winner, at, minutes: null }];
}

module.exports = {
  WEIGHTS, HISTORY_WINDOW_H, RECENT_PENALTY,
  needFromDeadline, fairnessFromHistory, scoreClaimant, rank,
  computeAllocation, historyRecords,
};