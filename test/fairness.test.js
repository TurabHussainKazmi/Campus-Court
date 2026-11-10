'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/fairness');

const H = 3600e3;
const T0 = 1_000_000_000_000; // fixed clock for deterministic tests

test('needFromDeadline buckets', () => {
  assert.equal(F.needFromDeadline(1), 10);
  assert.equal(F.needFromDeadline(6), 10);
  assert.equal(F.needFromDeadline(24), 8);
  assert.equal(F.needFromDeadline(48), 6);
  assert.equal(F.needFromDeadline(72), 4);
  assert.equal(F.needFromDeadline(168), 2);
  assert.equal(F.needFromDeadline(400), 1);
  assert.equal(F.needFromDeadline(-5), 10); // past deadline = maximum need
});

test('fairnessFromHistory deprioritises recent recipients', () => {
  assert.equal(F.fairnessFromHistory([], 'A', T0), 10);
  assert.equal(F.fairnessFromHistory([{ roll: 'A', at: T0 }], 'A', T0), 7); // just now: -3
  assert.equal(F.fairnessFromHistory([{ roll: 'A', at: T0 - 168 * H }], 'A', T0), 10); // 7 days ago: no penalty
  assert.equal(F.fairnessFromHistory([{ roll: 'B', at: T0 }], 'A', T0), 10); // someone else
  const two = [{ roll: 'A', at: T0 }, { roll: 'A', at: T0 }];
  assert.equal(F.fairnessFromHistory(two, 'A', T0), 4); // -6
});

test('weights sum to 1 and total is on a 1..10 scale', () => {
  const sum = F.WEIGHTS.urgency + F.WEIGHTS.need + F.WEIGHTS.fairness;
  assert.equal(Math.round(sum * 100) / 100, 1);
  const r = F.computeAllocation({
    resource: 'X', nowTs: T0,
    claimants: [{ roll: 'A', name: 'A', urgency: 10, deadline: T0 + 1 * H }],
  });
  assert.equal(r.table[0].total, 10); // 0.4*10 + 0.35*10 + 0.25*10
});

test('exclusive allocation: higher total wins', () => {
  const r = F.computeAllocation({
    resource: 'Laptop', nowTs: T0,
    claimants: [
      { roll: 'A', name: 'A', urgency: 5, deadline: T0 + 200 * H },
      { roll: 'B', name: 'B', urgency: 9, deadline: T0 + 200 * H },
    ],
  });
  assert.equal(r.allocation.mode, 'exclusive');
  assert.equal(r.allocation.winner, 'B');
  assert.equal(r.table[0].roll, 'B');
  assert.equal(r.table[0].rank, 1);
});

test('time-sharing splits the window proportionally and sums exactly', () => {
  const r = F.computeAllocation({
    resource: 'Lab PC', nowTs: T0, timeSharing: true, windowMinutes: 180,
    claimants: [
      { roll: 'A', name: 'A', urgency: 9, deadline: T0 + 10 * H },
      { roll: 'B', name: 'B', urgency: 7, deadline: T0 + 40 * H },
      { roll: 'C', name: 'C', urgency: 5, deadline: T0 + 150 * H },
    ],
  });
  assert.equal(r.allocation.mode, 'time-share');
  const total = r.allocation.slots.reduce((s, x) => s + x.minutes, 0);
  assert.equal(total, 180);
  assert.ok(r.allocation.slots[0].minutes >= r.allocation.slots[1].minutes);
  assert.ok(r.allocation.slots[1].minutes >= r.allocation.slots[2].minutes);
});

test('recent recipient loses to an equal-urgency newcomer', () => {
  const history = [{ roll: 'A', at: T0 }];
  const r = F.computeAllocation({
    resource: 'Printer', nowTs: T0, history,
    claimants: [
      { roll: 'A', name: 'A', urgency: 9, deadline: T0 + 200 * H },
      { roll: 'C', name: 'C', urgency: 9, deadline: T0 + 200 * H },
    ],
  });
  const a = r.table.find((x) => x.roll === 'A');
  const c = r.table.find((x) => x.roll === 'C');
  assert.equal(a.fairness, 7);
  assert.equal(c.fairness, 10);
  assert.equal(r.allocation.winner, 'C');
});

test('deterministic: identical inputs produce identical output', () => {
  const input = {
    resource: 'Book', nowTs: T0,
    claimants: [
      { roll: 'A', name: 'A', urgency: 6, deadline: T0 + 30 * H },
      { roll: 'B', name: 'B', urgency: 8, deadline: T0 + 5 * H },
    ],
  };
  assert.equal(JSON.stringify(F.computeAllocation(input)), JSON.stringify(F.computeAllocation(input)));
});

test('historyRecords reflect the allocation', () => {
  const r = F.computeAllocation({
    resource: 'PC', nowTs: T0, timeSharing: true, windowMinutes: 100,
    claimants: [
      { roll: 'A', name: 'A', urgency: 9, deadline: T0 + 5 * H },
      { roll: 'B', name: 'B', urgency: 4, deadline: T0 + 200 * H },
    ],
  });
  const rec = F.historyRecords(r, 'case1', 'PC');
  assert.equal(rec.length, 2);
  assert.ok(rec.every((x) => x.caseId === 'case1' && x.resource === 'PC' && x.at === T0));
});