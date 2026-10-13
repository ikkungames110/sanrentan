import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, createGame, addPlayer, act, view } from '../src/game.js';

test('役の判定', () => {
  const s = [0, 1, 2, 6];
  assert.equal(score([0, 1, 2], s, true).pts, 6);
  assert.equal(score([2, 0, 1], s, true).yaku, 'サンレンプク');
  assert.equal(score([0, 1, 5], s, true).yaku, 'ニレンタン');
  assert.equal(score([1, 0, 5], s, true).yaku, 'プクプク');
  assert.equal(score([0, 4, 5], s, true).yaku, 'タン');
  assert.equal(score([3, 4, 5], s, true).pts, 0);
  assert.equal(score([0, 4, 6], s, true).pts, 0); // タン(1) - ドボン(1)
  assert.equal(score([0, 4, 6], s, false).pts, 1);
});

test('1ラウンド通しで進行し最終結果になる', () => {
  const g = createGame('h', 'ホスト');
  addPlayer(g, 'a', 'A');
  addPlayer(g, 'b', 'B');
  assert.equal(act(g, 'h', { type: 'settings', dobon: true }), null);
  assert.equal(act(g, 'h', { type: 'start' }), null);
  for (let t = 0; t < 3; t++) {
    const s = g.setterId;
    assert.equal(act(g, s, { type: 'pickTopic', index: 1 }), null);
    for (const id of g.order) act(g, id, { type: 'submit', sel: id === s ? [0, 1, 2, 3] : [0, 1, 2] });
    assert.equal(g.phase, 'reveal');
    // 公開前の予想は他人に見えない
    assert.deepEqual(view(g, s).reveal.guesses[g.order.find((x) => x !== s)], [null, null, null]);
    for (let i = 0; i <= 7; i++) assert.equal(act(g, s, { type: 'advance' }), null);
    assert.equal(g.phase, 'result');
    act(g, s, { type: 'next' });
  }
  assert.equal(g.phase, 'final');
  assert.deepEqual(g.players.map((p) => p.score), [12, 12, 12]);
});
