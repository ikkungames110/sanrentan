import './style.css';
import { hostRoom, joinRoom, normalizeCode } from './net.js';
import {
  createGame, addPlayer, setConnected, removePlayer, act, view,
  LETTERS, MIN_PLAYERS, MAX_PLAYERS, stepLabel,
} from './game.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const LAST_KEY = 'sanrentan-last';
const NAME_KEY = 'sanrentan-name';

// 端末(タブ)ごとのプレイヤーID。リロードしても同じ席に戻れるよう sessionStorage に保持する。
const newId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
let myId = sessionStorage.getItem('sanrentan-id') || newId();
sessionStorage.setItem('sanrentan-id', myId);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlRoom = normalizeCode(new URLSearchParams(location.search).get('room') || '');

const ui = {
  screen: 'home', // home | connecting | room | error
  status: '',
  role: null, // host | guest
  roomCode: null,
  v: null,
  sel: [null, null, null, null],
  active: 0,
  turnNo: null,
  reconnecting: false,
  rules: false,
  error: null,
};

let net = null;

// ───────── ホスト側 ─────────
let game = null;
const cidToPid = new Map();

function startHost(name) {
  ui.screen = 'connecting';
  ui.status = '部屋を準備中…';
  render();
  net = hostRoom({
    onCode(code) {
      ui.role = 'host';
      ui.roomCode = code;
      game = createGame(myId, name);
      ui.screen = 'room';
      sync();
    },
    onMessage: onGuestMessage,
    onClose(cid) {
      const pid = cidToPid.get(cid);
      cidToPid.delete(cid);
      if (pid && ![...cidToPid.values()].includes(pid)) { setConnected(game, pid, false); sync(); }
    },
    onError(type) { showError('部屋を作れませんでした', explain(type)); },
  });
}

function onGuestMessage(cid, m) {
  if (!game) return;
  if (m.t === 'hello') {
    const id = String(m.id || '').slice(0, 64);
    const name = String(m.name || '').trim().slice(0, 12) || 'ゲスト';
    if (!id || id === myId) { net.send(cid, { t: 'reject', msg: '同じ端末のタブからは参加できません' }); return; }
    const err = addPlayer(game, id, name);
    if (err) { net.send(cid, { t: 'reject', msg: err }); setTimeout(() => net.drop(cid), 800); return; }
    for (const [c, p] of cidToPid) if (p === id && c !== cid) { cidToPid.delete(c); net.drop(c); }
    cidToPid.set(cid, id);
    sync();
    return;
  }
  if (m.t === 'act') {
    const pid = cidToPid.get(cid);
    if (!pid) return;
    const err = act(game, pid, m.a);
    if (err) net.send(cid, { t: 'err', msg: err });
    sync();
  }
}

function sync() {
  for (const [cid, pid] of cidToPid) {
    if (!game.players.some((p) => p.id === pid)) {
      net.send(cid, { t: 'kicked' });
      cidToPid.delete(cid);
      setTimeout(() => net.drop(cid), 800);
      continue;
    }
    net.send(cid, { t: 'state', s: view(game, pid) });
  }
  setView(view(game, myId));
}

// ───────── ゲスト側 ─────────
let retries = 0;
let retryTimer = null;

function startJoin(code, name) {
  ui.role = 'guest';
  ui.roomCode = code;
  if (ui.screen !== 'room') { ui.screen = 'connecting'; ui.status = `部屋 ${code} に接続中…`; render(); }
  net?.close();
  const link = joinRoom(code, {
    onOpen() {
      link.send({ t: 'hello', id: myId, name });
      localStorage.setItem(LAST_KEY, JSON.stringify({ code, id: myId, name, at: Date.now() }));
    },
    onMessage(m) {
      if (m.t === 'state') {
        retries = 0;
        ui.reconnecting = false;
        ui.screen = 'room';
        setView(m.s);
      } else if (m.t === 'err') toast(m.msg);
      else if (m.t === 'reject') { leave(false); showError('参加できませんでした', m.msg); }
      else if (m.t === 'kicked') { leave(false); showError('部屋から退出しました', 'ホストによって除外されました'); }
    },
    onClose() { scheduleRetry(); },
    onError(type) {
      if (ui.screen === 'room') scheduleRetry();
      else showError('接続できませんでした', explain(type));
    },
  });
  net = link;
  net.name = name;
}

function scheduleRetry() {
  if (ui.role !== 'guest') return;
  if (retries++ >= 30) { const n = ui.roomCode; leave(false); showError('接続が切れました', `部屋 ${n} に再接続できませんでした。ホストが退出した可能性があります。`); return; }
  ui.reconnecting = true;
  render();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => startJoin(ui.roomCode, net?.name || localName()), 2000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ui.role === 'guest' && ui.reconnecting) { clearTimeout(retryTimer); startJoin(ui.roomCode, net?.name || localName()); }
  if (ui.role === 'host') net?.reconnectSignal();
});

// ───────── 共通 ─────────
function doAct(a) {
  if (ui.role === 'host') {
    const err = act(game, myId, a);
    if (err) toast(err);
    sync();
  } else net?.send({ t: 'act', a });
}

function setView(v) {
  if (v.turnNo !== ui.turnNo || v.phase !== 'answer') {
    if (v.turnNo !== ui.turnNo) { ui.sel = [null, null, null, null]; ui.active = 0; }
    ui.turnNo = v.turnNo;
  }
  ui.v = v;
  render();
}

function leave(clearLast = true) {
  clearTimeout(retryTimer);
  net?.close();
  net = null;
  game = null;
  cidToPid.clear();
  if (clearLast) localStorage.removeItem(LAST_KEY);
  Object.assign(ui, { screen: 'home', role: null, roomCode: null, v: null, reconnecting: false, turnNo: null });
  retries = 0;
  render();
}

function showError(title, sub) {
  clearTimeout(retryTimer);
  net?.close();
  net = null;
  ui.role = null;
  ui.screen = 'error';
  ui.error = { title, sub };
  render();
}

function explain(type) {
  return {
    'peer-unavailable': '部屋が見つかりません。コードを確認してください。',
    timeout: '時間内に接続できませんでした。電波状況を確認してもう一度お試しください。',
    network: 'ネットワークに接続できません。',
    'server-error': '接続サーバーに問題が発生しました。しばらくしてからお試しください。',
    'browser-incompatible': 'このブラウザは対応していません。',
  }[type] || `エラー: ${type}`;
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2400);
}

const localName = () => localStorage.getItem(NAME_KEY) || '';
const nameOf = (id) => ui.v?.players.find((p) => p.id === id)?.name ?? '（退出）';
const isHost = () => ui.role === 'host';
const shareUrl = () => `${location.origin}${location.pathname}?room=${ui.roomCode}`;

// ───────── 描画 ─────────
function render() {
  let html = '';
  if (ui.screen === 'home') html = homeHtml();
  else if (ui.screen === 'connecting') html = `<div class="center"><div class="spinner"></div><p>${esc(ui.status)}</p><button class="ghost" data-act="leave">キャンセル</button></div>`;
  else if (ui.screen === 'error') html = `<div class="center"><h2>${esc(ui.error.title)}</h2><p class="sub">${esc(ui.error.sub)}</p><button class="primary" data-act="home">トップへ</button></div>`;
  else if (ui.screen === 'room' && ui.v) html = roomHtml();
  if (ui.rules) html += rulesHtml();
  $app.innerHTML = html;
}

function homeHtml() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_KEY)); } catch {}
  if (last && Date.now() - last.at > 6 * 3600e3) last = null;
  return `
  <div class="home">
    <h1 class="logo"><span>サン</span><span>レン</span><span>タン</span></h1>
    <p class="tag">出題者の“価値観”を当てろ！</p>
    <label class="field">ニックネーム
      <input id="in-name" maxlength="12" autocomplete="nickname" placeholder="例：たろう" value="${esc(localName())}" />
    </label>
    <button class="primary" data-act="create">部屋をつくる</button>
    <div class="or">または</div>
    <div class="join-row">
      <input id="in-code" class="code-input" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="部屋コード" value="${esc(urlRoom)}" />
      <button class="primary alt" data-act="join">参加</button>
    </div>
    ${last ? `<button class="ghost" data-act="rejoin">前回の部屋（${esc(last.code)}）に戻る</button>` : ''}
    <button class="ghost" data-act="rules">あそびかた</button>
    <a class="ghost" href="./topics.html">お題一覧を見る</a>
  </div>`;
}

function rulesHtml() {
  return `
  <div class="modal" data-act="rules-close">
    <section class="sheet" data-stop>
      <h2>あそびかた</h2>
      <ol>
        <li>出題者を1人決め、残りは回答者です。</li>
        <li>出題者は3つの候補からお題を1つ選びます。お題には回答候補 A〜G がセットになっています。</li>
        <li>出題者は自分の本音で <b>1位〜3位</b>（ドボンありなら <b>ドボン＝7位</b> も）を選びます。回答者は同時に出題者の1位〜3位を予想します。</li>
        <li>全員の選択が終わったら、回答者の3位→2位→1位→出題者の3位→2位→1位→ドボンの順に公開。出題者は1つずつ理由を語ってから次へ進めます。</li>
        <li>全員が1回ずつ出題したら1ラウンド。指定ラウンド終了時の合計点で順位が決まります。</li>
      </ol>
      <table class="score-table">
        <tr><th>サンレンタン</th><td>1〜3位すべて順位まで一致</td><td>6点</td></tr>
        <tr><th>サンレンプク</th><td>1〜3位すべて一致（順位不問）</td><td>4点</td></tr>
        <tr><th>ニレンタン</th><td>1位・2位が順位まで一致</td><td>3点</td></tr>
        <tr><th>プクプク</th><td>選択肢が2つ一致（順位不問）</td><td>2点</td></tr>
        <tr><th>タン</th><td>1位が順位まで一致</td><td>1点</td></tr>
        <tr><th>ハズレ</th><td>上記以外</td><td>0点</td></tr>
        <tr class="bomb"><th>ドボン</th><td>予想にドボンが入っている</td><td>−1点</td></tr>
      </table>
      <button class="primary" data-act="rules-close">とじる</button>
    </section>
  </div>`;
}

function roomHtml() {
  const v = ui.v;
  const body = {
    lobby: lobbyHtml, choose: chooseHtml, answer: answerHtml,
    reveal: revealHtml, result: resultHtml, final: finalHtml,
  }[v.phase]();
  const info = v.phase === 'lobby' || v.phase === 'final'
    ? ''
    : `<span class="pill">R${v.round}/${v.settings.rounds}</span><span class="pill">${Math.max(0, v.turnPos) + 1}/${v.order.length}人目</span>`;
  return `
  <header class="bar">
    <span class="room">🏠 ${esc(ui.roomCode)}</span>${info}
    <span class="grow"></span>
    <button class="icon" data-act="rules" aria-label="ルール">?</button>
    <button class="icon" data-act="leave-room" aria-label="退出">✕</button>
  </header>
  ${ui.reconnecting ? '<div class="banner">再接続中…</div>' : ''}
  <main class="page">${body}</main>`;
}

function playersHtml({ showScore = true, marks = {} } = {}) {
  const v = ui.v;
  const list = v.phase === 'lobby' ? v.players : v.order.map((id) => v.players.find((p) => p.id === id)).filter(Boolean);
  return `<ul class="players">${list.map((p) => `
    <li class="${p.connected ? '' : 'off'}">
      <span class="dot"></span>
      <span class="pname">${esc(p.name)}${p.id === myId ? '<small>（あなた）</small>' : ''}${p.id === v.hostId ? '<small class="tag-host">ホスト</small>' : ''}${p.id === v.setterId ? '<small class="tag-setter">出題者</small>' : ''}</span>
      ${marks[p.id] ?? ''}
      ${showScore && v.phase !== 'lobby' ? `<span class="pts">${p.score}点</span>` : ''}
      ${isHost() && p.id !== myId && (v.phase === 'lobby' || !p.connected) ? `<button class="kick" data-act="kick" data-id="${esc(p.id)}">除外</button>` : ''}
    </li>`).join('')}</ul>`;
}

function lobbyHtml() {
  const v = ui.v;
  const h = isHost();
  return `
  <section class="card center-text">
    <div class="label">部屋コード</div>
    <div class="code">${esc(ui.roomCode)}</div>
    <button class="primary alt small" data-act="share">招待リンクを共有</button>
  </section>
  <section class="card">
    <h3>プレイヤー <small>${v.players.length}/${MAX_PLAYERS}</small></h3>
    ${playersHtml()}
  </section>
  <section class="card">
    <h3>ルール設定</h3>
    <div class="setting">
      <span>ドボン（7位）</span>
      <div class="seg">
        <button class="${!v.settings.dobon ? 'on' : ''}" data-act="set-dobon" data-val="0" ${h ? '' : 'disabled'}>なし</button>
        <button class="${v.settings.dobon ? 'on' : ''}" data-act="set-dobon" data-val="1" ${h ? '' : 'disabled'}>あり</button>
      </div>
    </div>
    <div class="setting">
      <span>ラウンド数</span>
      <div class="stepper">
        <button data-act="rounds" data-d="-1" ${h && v.settings.rounds > 1 ? '' : 'disabled'}>−</button>
        <b>${v.settings.rounds}</b>
        <button data-act="rounds" data-d="1" ${h && v.settings.rounds < 10 ? '' : 'disabled'}>＋</button>
      </div>
    </div>
    <p class="note">1ラウンド＝全員が1回ずつ出題（${v.players.length}人なら${v.players.length * v.settings.rounds}問）</p>
  </section>
  ${h
    ? `<button class="primary" data-act="start" ${v.players.length >= MIN_PLAYERS ? '' : 'disabled'}>ゲーム開始</button>
       ${v.players.length < MIN_PLAYERS ? `<p class="note center-text">${MIN_PLAYERS}人以上で開始できます</p>` : ''}`
    : '<p class="wait">ホストの開始を待っています…</p>'}`;
}

function chooseHtml() {
  const v = ui.v;
  if (v.setterId === myId && v.candidates) {
    return `
    <h2 class="headline">あなたが出題者です</h2>
    <p class="sub center-text">お題を1つ選んでください</p>
    ${v.candidates.map((c) => `<button class="topic-choice" data-act="pick" data-i="${c.index}">${esc(c.q)}</button>`).join('')}
    <section class="card">${playersHtml()}</section>`;
  }
  return `
  <div class="center"><div class="spinner"></div>
    <p><b>${esc(nameOf(v.setterId))}</b> さんがお題を選んでいます…</p></div>
  <section class="card">${playersHtml()}</section>`;
}

function topicHtml(sub) {
  const v = ui.v;
  return `<section class="topic">
    <div class="by">出題者：${esc(nameOf(v.setterId))}</div>
    <div class="q">${esc(v.topic.q)}</div>
    ${sub ? `<div class="by">${sub}</div>` : ''}
  </section>`;
}

const RANKS = ['1位', '2位', '3位', 'ドボン'];

function answerHtml() {
  const v = ui.v;
  const setter = v.setterId === myId;
  const n = setter && v.settings.dobon ? 4 : 3;
  const waiting = v.order.filter((id) => !v.submitted.includes(id));
  const marks = Object.fromEntries(v.order.map((id) => [id, v.submitted.includes(id) ? '<span class="ok">✓ 完了</span>' : '<span class="thinking">考え中…</span>']));
  const inGame = v.order.includes(myId);
  if (!inGame) return `${topicHtml()}<p class="wait">観戦中</p><section class="card">${playersHtml({ marks })}</section>`;

  if (v.mine) {
    return `
    ${topicHtml(setter ? 'あなたの順位' : 'あなたの予想')}
    <section class="card">
      <div class="mine">${v.mine.map((x, i) => `<div class="mine-row ${i === 3 ? 'bomb' : ''}"><span class="rk">${RANKS[i]}</span><span class="lt">${LETTERS[x]}</span><span>${esc(v.topic.o[x])}</span></div>`).join('')}</div>
      <button class="ghost small" data-act="cancel">選び直す</button>
    </section>
    <p class="wait">${waiting.length ? `あと${waiting.length}人の回答を待っています…` : '公開します！'}</p>
    <section class="card">${playersHtml({ marks, showScore: false })}</section>`;
  }

  const sel = ui.sel.slice(0, n);
  const full = sel.every((x) => x != null);
  return `
  ${topicHtml(setter ? 'あなたの本音で順位をつけてください' : `${esc(nameOf(v.setterId))} さんの1〜3位を予想！`)}
  <div class="slots">
    ${sel.map((x, i) => `<button class="slot ${ui.active === i ? 'active' : ''} ${i === 3 ? 'bomb' : ''}" data-act="slot" data-i="${i}">
      <span class="rk">${RANKS[i]}</span><span class="lt">${x != null ? LETTERS[x] : '—'}</span></button>`).join('')}
  </div>
  <div class="options">
    ${v.topic.o.map((t, i) => {
      const k = sel.indexOf(i);
      return `<button class="opt ${k >= 0 ? 'picked' : ''} ${k === 3 ? 'bomb' : ''}" data-act="opt" data-i="${i}">
        <span class="lt">${LETTERS[i]}</span><span class="tx">${esc(t)}</span>${k >= 0 ? `<span class="rk-tag">${RANKS[k]}</span>` : ''}</button>`;
    }).join('')}
  </div>
  <button class="primary sticky" data-act="submit" ${full ? '' : 'disabled'}>${full ? '決定' : `${RANKS[ui.active] ?? ''}を選んでください`}</button>
  <section class="card">${playersHtml({ marks, showScore: false })}</section>`;
}

// 予想セルの色: 順位まで一致=hit / 順位違いで含まれる=near / ドボン=bomb
function cellClass(x, rank, setter) {
  if (x == null) return 'hidden';
  if (setter[3] != null && x === setter[3]) return 'bomb';
  if (setter[rank] === x) return 'hit';
  if (setter.slice(0, 3).includes(x)) return 'near';
  return '';
}

function revealTable() {
  const v = ui.v;
  const { guesses, setter } = v.reveal;
  const ids = v.order.filter((id) => id !== v.setterId && guesses[id]);
  const dob = v.settings.dobon;
  const cell = (x, cls = '') => `<td class="c ${cls}">${x == null ? '?' : LETTERS[x]}</td>`;
  return `
  <table class="reveal">
    <thead><tr><th></th><th>1位</th><th>2位</th><th>3位</th>${dob ? '<th>ドボン</th>' : ''}</tr></thead>
    <tbody>
      <tr class="setter-row"><th>${esc(nameOf(v.setterId))}<small>出題者</small></th>
        ${setter.slice(0, 3).map((x) => cell(x, x == null ? 'hidden' : 'ans')).join('')}
        ${dob ? cell(setter[3], setter[3] == null ? 'hidden' : 'bomb') : ''}</tr>
      ${ids.map((id) => `<tr><th>${esc(nameOf(id))}${id === myId ? '<small>あなた</small>' : ''}</th>
        ${guesses[id].map((x, r) => cell(x, cellClass(x, r, setter))).join('')}${dob ? '<td></td>' : ''}</tr>`).join('')}
    </tbody>
  </table>`;
}

function legendHtml() {
  const v = ui.v;
  const s = v.reveal.setter;
  return `<ul class="legend">${v.topic.o.map((t, i) => {
    const k = s.indexOf(i);
    return `<li class="${k === 3 ? 'bomb' : k >= 0 ? 'ans' : ''}"><span class="lt">${LETTERS[i]}</span><span class="tx">${esc(t)}</span>${k >= 0 ? `<span class="rk-tag">${RANKS[k]}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

function revealHtml() {
  const v = ui.v;
  const last = v.steps[v.step - 1];
  let spot = '<div class="spot muted">まもなく公開！</div>';
  if (last?.startsWith('g')) spot = `<div class="spot">${stepLabel(last)}を公開！</div>`;
  else if (last) {
    const idx = { s1: 0, s2: 1, s3: 2, sd: 3 }[last];
    const x = v.reveal.setter[idx];
    spot = `<div class="spot big ${last === 'sd' ? 'bomb' : ''}"><div class="spot-label">${stepLabel(last)}は…</div>
      <div class="spot-ans"><span class="lt">${LETTERS[x]}</span>${esc(v.topic.o[x])}</div></div>`;
  }
  const canGo = v.setterId === myId || isHost();
  const nextLabel = v.step < v.steps.length ? `${stepLabel(v.steps[v.step])}を公開` : '得点を見る';
  const hint = v.setterId === myId && last?.startsWith('s') ? '<p class="note center-text">選んだ理由を話してから次へどうぞ</p>' : '';
  return `
  ${topicHtml()}
  ${spot}
  ${revealTable()}
  ${hint}
  ${canGo
    ? `<button class="primary sticky" data-act="advance">${nextLabel}</button>${v.setterId !== myId ? '<p class="note center-text">（ホスト権限で進められます）</p>' : ''}`
    : `<p class="wait">${esc(nameOf(v.setterId))} さんの進行を待っています…</p>`}
  ${legendHtml()}`;
}

function resultHtml() {
  const v = ui.v;
  const rows = Object.entries(v.results).sort((a, b) => b[1].pts - a[1].pts);
  const last = v.round >= v.settings.rounds && v.turnPos >= v.order.length - 1;
  const canGo = v.setterId === myId || isHost();
  return `
  ${topicHtml()}
  ${revealTable()}
  <section class="card">
    <h3>今回の得点</h3>
    <ul class="results">${rows.map(([id, r]) => `
      <li class="${r.base >= 4 ? 'great' : ''}">
        <span class="pname">${esc(nameOf(id))}</span>
        <span class="yaku">${r.yaku}${r.dobon ? '<em class="bomb-tag">ドボン</em>' : ''}</span>
        <span class="gain ${r.pts < 0 ? 'neg' : ''}">${r.pts > 0 ? '+' : ''}${r.pts}</span>
      </li>`).join('')}</ul>
  </section>
  <section class="card"><h3>合計</h3>${playersHtml()}</section>
  ${canGo ? `<button class="primary sticky" data-act="next">${last ? '最終結果へ' : '次の出題へ'}</button>` : '<p class="wait">次の出題を待っています…</p>'}
  ${legendHtml()}`;
}

function finalHtml() {
  const v = ui.v;
  const ps = v.players.slice().sort((a, b) => b.score - a.score);
  let rank = 0;
  const rows = ps.map((p, i) => {
    if (i === 0 || p.score !== ps[i - 1].score) rank = i + 1;
    return { p, rank };
  });
  return `
  <h2 class="headline">最終結果</h2>
  <ol class="ranking">${rows.map(({ p, rank }) => `
    <li class="r${rank}"><span class="rank">${rank}位</span><span class="pname">${esc(p.name)}${p.id === myId ? '<small>（あなた）</small>' : ''}</span><span class="pts">${p.score}点</span></li>`).join('')}</ol>
  ${isHost() ? '<button class="primary" data-act="to-lobby">もう一度あそぶ</button>' : '<p class="wait">ホストの操作を待っています…</p>'}
  <button class="ghost" data-act="leave-room">退出する</button>`;
}

// ───────── 操作 ─────────
function readName() {
  const el = document.getElementById('in-name');
  const name = (el?.value || '').trim().slice(0, 12);
  if (!name) { toast('ニックネームを入力してください'); el?.focus(); return null; }
  localStorage.setItem(NAME_KEY, name);
  return name;
}

function pickOption(i) {
  const v = ui.v;
  const n = v.setterId === myId && v.settings.dobon ? 4 : 3;
  const sel = ui.sel;
  const k = sel.indexOf(i);
  if (k >= 0 && k < n) { sel[k] = null; ui.active = k; return; }
  if (ui.active >= n) ui.active = 0;
  sel[ui.active] = i;
  for (let d = 1; d <= n; d++) {
    const j = (ui.active + d) % n;
    if (sel[j] == null) { ui.active = j; return; }
  }
}

const handlers = {
  create() { const n = readName(); if (n) startHost(n); },
  join() {
    const n = readName(); if (!n) return;
    const code = normalizeCode(document.getElementById('in-code').value);
    if (code.length !== 5) { toast('5文字の部屋コードを入力してください'); return; }
    retries = 0;
    startJoin(code, n);
  },
  rejoin() {
    let last; try { last = JSON.parse(localStorage.getItem(LAST_KEY)); } catch {}
    if (!last) return;
    myId = last.id;
    sessionStorage.setItem('sanrentan-id', myId);
    retries = 0;
    startJoin(last.code, last.name);
  },
  rules() { ui.rules = true; render(); },
  'rules-close'(el, e) { if (e.target.closest('[data-stop]') && !e.target.closest('[data-act="rules-close"]')) return; ui.rules = false; render(); },
  leave() { leave(); },
  home() { ui.screen = 'home'; render(); },
  'leave-room'() {
    const msg = isHost() ? 'ホストが退出すると部屋が解散します。退出しますか？' : '退出しますか？';
    if (confirm(msg)) leave();
  },
  async share() {
    const url = shareUrl();
    try {
      if (navigator.share) await navigator.share({ title: 'サンレンタン', text: `サンレンタンの部屋 ${ui.roomCode} に参加しよう！`, url });
      else { await navigator.clipboard.writeText(url); toast('リンクをコピーしました'); }
    } catch (e) { if (e?.name !== 'AbortError') toast(url); }
  },
  'set-dobon'(el) { doAct({ type: 'settings', dobon: el.dataset.val === '1' }); },
  rounds(el) { doAct({ type: 'settings', rounds: ui.v.settings.rounds + Number(el.dataset.d) }); },
  start() { doAct({ type: 'start' }); },
  kick(el) { if (confirm(`${nameOf(el.dataset.id)} さんを除外しますか？`)) doAct({ type: 'kick', id: el.dataset.id }); },
  pick(el) { doAct({ type: 'pickTopic', index: Number(el.dataset.i) }); },
  slot(el) {
    const i = Number(el.dataset.i);
    if (ui.active === i && ui.sel[i] != null) ui.sel[i] = null;
    ui.active = i;
    render();
  },
  opt(el) { pickOption(Number(el.dataset.i)); render(); },
  submit() {
    const n = ui.v.setterId === myId && ui.v.settings.dobon ? 4 : 3;
    const sel = ui.sel.slice(0, n);
    if (sel.some((x) => x == null)) return;
    doAct({ type: 'submit', sel });
  },
  cancel() {
    if (ui.v.mine) { ui.sel = [...ui.v.mine, null, null, null, null].slice(0, 4); ui.active = 0; }
    doAct({ type: 'cancel' });
  },
  advance() { doAct({ type: 'advance' }); },
  next() { doAct({ type: 'next' }); },
  'to-lobby'() { doAct({ type: 'lobby' }); },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  handlers[el.dataset.act]?.(el, e);
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'in-code') handlers.join();
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'in-code') {
    const pos = e.target.value;
    e.target.value = normalizeCode(pos);
  }
});
window.addEventListener('beforeunload', (e) => {
  if (ui.role === 'host' && game) { e.preventDefault(); e.returnValue = ''; }
});

render();
