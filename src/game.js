import { TOPICS } from './topics.js';

// ゲーム進行の状態はホストだけが持つ。各端末には view() で見せてよい情報だけを送る。
export const LETTERS = 'ABCDEFG';
export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 2;

const STEP_LABELS = {
  g3: '回答者の3位', g2: '回答者の2位', g1: '回答者の1位',
  s3: '出題者の3位', s2: '出題者の2位', s1: '出題者の1位', sd: '出題者のドボン',
};
export const stepLabel = (s) => STEP_LABELS[s] ?? '';

// guess: [1位,2位,3位], setter: [1位,2位,3位,ドボン?]
export function score(guess, setter, dobonOn) {
  const [g1, g2, g3] = guess;
  const [s1, s2, s3, sd] = setter;
  const top = [s1, s2, s3];
  const common = guess.filter((x) => top.includes(x)).length;
  let yaku, base;
  if (g1 === s1 && g2 === s2 && g3 === s3) [yaku, base] = ['サンレンタン', 6];
  else if (common === 3) [yaku, base] = ['サンレンプク', 4];
  else if (g1 === s1 && g2 === s2) [yaku, base] = ['ニレンタン', 3];
  else if (common === 2) [yaku, base] = ['プクプク', 2];
  else if (g1 === s1) [yaku, base] = ['タン', 1];
  else [yaku, base] = ['ハズレ', 0];
  const dobon = !!dobonOn && sd != null && guess.includes(sd);
  return { yaku, base, dobon, pts: base - (dobon ? 1 : 0) };
}

export function createGame(hostId, hostName) {
  return {
    phase: 'lobby',
    hostId,
    settings: { dobon: false, rounds: 1 },
    players: [{ id: hostId, name: hostName, score: 0, connected: true }],
    order: [], round: 1, turnPos: 0, setterId: null,
    candidates: [], topic: null, used: [],
    answers: {}, setterAns: null,
    steps: [], step: 0, results: null, turnNo: 0,
  };
}

const player = (g, id) => g.players.find((p) => p.id === id);
const guessers = (g) => g.order.filter((id) => id !== g.setterId);

export function addPlayer(g, id, name) {
  const p = player(g, id);
  if (p) { p.connected = true; if (name) p.name = name; return null; }
  if (g.phase !== 'lobby') return 'ゲームが進行中のため参加できません';
  if (g.players.length >= MAX_PLAYERS) return '満員です';
  g.players.push({ id, name, score: 0, connected: true });
  return null;
}

export function setConnected(g, id, on) {
  const p = player(g, id);
  if (p) p.connected = on;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function beginTurn(g, rng) {
  g.setterId = g.order[g.turnPos];
  let pool = TOPICS.map((_, i) => i).filter((i) => !g.used.includes(i));
  if (pool.length < 3) { g.used = []; pool = TOPICS.map((_, i) => i); }
  g.candidates = shuffle(pool, rng).slice(0, 3);
  g.topic = null;
  g.answers = {};
  g.setterAns = null;
  g.steps = [];
  g.step = 0;
  g.results = null;
  g.turnNo++;
  g.phase = 'choose';
}

function nextTurn(g, rng) {
  g.turnPos++;
  if (g.turnPos >= g.order.length) { g.turnPos = 0; g.round++; }
  if (g.round > g.settings.rounds || g.order.length < MIN_PLAYERS) { g.phase = 'final'; return; }
  beginTurn(g, rng);
}

function maybeStartReveal(g) {
  if (g.phase !== 'answer' || !g.setterAns) return;
  if (!guessers(g).every((id) => g.answers[id])) return;
  g.steps = ['g3', 'g2', 'g1', 's3', 's2', 's1'];
  if (g.settings.dobon) g.steps.push('sd');
  g.step = 0;
  g.phase = 'reveal';
}

function finishReveal(g) {
  g.results = {};
  for (const id of guessers(g)) {
    const r = score(g.answers[id], g.setterAns, g.settings.dobon);
    g.results[id] = r;
    const p = player(g, id);
    if (p) p.score += r.pts;
  }
  g.phase = 'result';
}

export function removePlayer(g, id, rng = Math.random) {
  const idx = g.order.indexOf(id);
  g.players = g.players.filter((p) => p.id !== id);
  delete g.answers[id];
  if (g.phase === 'lobby' || idx < 0) return;
  g.order.splice(idx, 1);
  if (g.phase === 'final') return;
  if (g.order.length < MIN_PLAYERS) { g.phase = 'final'; return; }
  if (idx < g.turnPos) { g.turnPos--; return maybeStartReveal(g); }
  if (idx > g.turnPos) return maybeStartReveal(g);
  // 出題者が抜けた
  if (g.phase === 'choose' || g.phase === 'answer') {
    g.turnPos--;
    nextTurn(g, rng);
  } else {
    // 公開中・結果表示中はそのまま続け、「次へ」で正しい人に回るよう位置を戻す
    g.turnPos--;
  }
}

const validSel = (sel, n) =>
  Array.isArray(sel) && sel.length === n &&
  sel.every((x) => Number.isInteger(x) && x >= 0 && x < 7) &&
  new Set(sel).size === n;

// 戻り値: エラーメッセージ（成功時は null）
export function act(g, pid, a, rng = Math.random) {
  const isHost = pid === g.hostId;
  const isSetter = pid === g.setterId;
  switch (a?.type) {
    case 'settings': {
      if (!isHost || g.phase !== 'lobby') return '設定を変更できません';
      if (typeof a.dobon === 'boolean') g.settings.dobon = a.dobon;
      if (Number.isInteger(a.rounds) && a.rounds >= 1 && a.rounds <= 10) g.settings.rounds = a.rounds;
      return null;
    }
    case 'kick': {
      if (!isHost || a.id === g.hostId) return '操作できません';
      removePlayer(g, a.id, rng);
      return null;
    }
    case 'start': {
      if (!isHost || g.phase !== 'lobby') return '開始できません';
      if (g.players.length < MIN_PLAYERS) return `${MIN_PLAYERS}人以上で開始できます`;
      for (const p of g.players) p.score = 0;
      g.order = shuffle(g.players.map((p) => p.id), rng);
      g.round = 1;
      g.turnPos = 0;
      g.turnNo = 0;
      beginTurn(g, rng);
      return null;
    }
    case 'pickTopic': {
      if (g.phase !== 'choose' || !isSetter) return 'お題を選べません';
      const t = g.candidates[a.index];
      if (t == null) return 'お題が不正です';
      g.topic = t;
      g.used.push(t);
      g.phase = 'answer';
      return null;
    }
    case 'submit': {
      if (g.phase !== 'answer' || !g.order.includes(pid)) return '今は回答できません';
      if (isSetter) {
        const n = g.settings.dobon ? 4 : 3;
        if (!validSel(a.sel, n)) return '選択が不正です';
        g.setterAns = a.sel.slice();
      } else {
        if (!validSel(a.sel, 3)) return '選択が不正です';
        g.answers[pid] = a.sel.slice();
      }
      maybeStartReveal(g);
      return null;
    }
    case 'cancel': {
      if (g.phase !== 'answer') return '変更できません';
      if (isSetter) g.setterAns = null;
      else delete g.answers[pid];
      return null;
    }
    case 'advance': {
      if (g.phase !== 'reveal' || !(isSetter || isHost)) return '進められません';
      if (g.step < g.steps.length) g.step++;
      else finishReveal(g);
      return null;
    }
    case 'next': {
      if (g.phase !== 'result' || !(isSetter || isHost)) return '進められません';
      nextTurn(g, rng);
      return null;
    }
    case 'lobby': {
      if (!isHost || g.phase !== 'final') return '操作できません';
      g.phase = 'lobby';
      for (const p of g.players) p.score = 0;
      g.setterId = null;
      return null;
    }
  }
  return '不明な操作です';
}

// pid から見える状態
export function view(g, pid) {
  const revealed = new Set(g.steps.slice(0, g.step));
  const done = g.phase === 'result' || g.phase === 'final';
  const show = (k) => done || revealed.has(k);
  const inTurn = ['choose', 'answer', 'reveal', 'result'].includes(g.phase);
  let reveal = null;
  if (g.phase === 'reveal' || g.phase === 'result') {
    const guesses = {};
    for (const id of guessers(g)) {
      const a = g.answers[id] || [];
      guesses[id] = [show('g1') ? a[0] : null, show('g2') ? a[1] : null, show('g3') ? a[2] : null];
    }
    const s = g.setterAns || [];
    reveal = {
      guesses,
      setter: [show('s1') ? s[0] : null, show('s2') ? s[1] : null, show('s3') ? s[2] : null,
        g.settings.dobon && show('sd') ? s[3] : null],
    };
  }
  return {
    phase: g.phase,
    hostId: g.hostId,
    settings: { ...g.settings },
    players: g.players.map((p) => ({ ...p })),
    order: g.order.slice(),
    round: g.round,
    turnPos: g.turnPos,
    turnNo: g.turnNo,
    setterId: inTurn ? g.setterId : null,
    candidates: g.phase === 'choose' && pid === g.setterId
      ? g.candidates.map((i) => ({ index: g.candidates.indexOf(i), q: TOPICS[i].q }))
      : null,
    topic: g.topic != null && inTurn ? TOPICS[g.topic] : null,
    submitted: g.phase === 'answer'
      ? [...(g.setterAns ? [g.setterId] : []), ...Object.keys(g.answers)]
      : [],
    mine: g.phase === 'answer' ? (pid === g.setterId ? g.setterAns : g.answers[pid]) ?? null : null,
    steps: g.steps.slice(),
    step: g.step,
    reveal,
    results: g.phase === 'result' ? g.results : null,
  };
}
