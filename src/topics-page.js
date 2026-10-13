import './style.css';
import './topics-page.css';
import { TOPICS, CATEGORIES } from './topics.js';
import { LETTERS } from './game.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $root = document.getElementById('list-app');
const state = { cat: null, q: '' };

$root.innerHTML = `
  <header class="list-head">
    <a class="back" href="./">← ゲームへ</a>
    <h1>お題一覧 <small>${TOPICS.length}問</small></h1>
    <input id="search" type="search" placeholder="お題・候補を検索" />
    <div class="chips">
      <button class="chip on" data-cat="">すべて</button>
      ${CATEGORIES.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)} <small>${TOPICS.filter((t) => t.c === c).length}</small></button>`).join('')}
    </div>
  </header>
  <main class="list-body" id="cards"></main>`;

const $cards = document.getElementById('cards');

function draw() {
  const q = state.q.trim();
  const items = TOPICS.map((t, i) => ({ t, no: i + 1 }))
    .filter(({ t }) => !state.cat || t.c === state.cat)
    .filter(({ t }) => !q || t.q.includes(q) || t.o.some((o) => o.includes(q)));
  $cards.innerHTML = items.length
    ? items.map(({ t, no }) => `
      <article class="tcard">
        <div class="tmeta"><span class="no">No.${no}</span><span class="cat">${esc(t.c)}</span></div>
        <h2>${esc(t.q)}</h2>
        <ol>${t.o.map((o, i) => `<li><span class="lt">${LETTERS[i]}</span><span>${esc(o)}</span></li>`).join('')}</ol>
      </article>`).join('')
    : '<p class="wait">該当するお題がありません</p>';
}

$root.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.cat = chip.dataset.cat || null;
  for (const c of $root.querySelectorAll('.chip')) c.classList.toggle('on', c === chip);
  draw();
});
document.getElementById('search').addEventListener('input', (e) => { state.q = e.target.value; draw(); });
draw();
