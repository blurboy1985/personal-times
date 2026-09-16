// Edition JSON → broadsheet pages. Every string is escaped; only http(s) links
// from our own collectors are ever rendered as hrefs.

export const PAGES = [
  { slug: 'world', folio: 'A1', title: 'The World' },
  { slug: 'inbox', folio: 'A2', title: 'The Inbox Dispatch' },
  { slug: 'markets', folio: 'A3', title: 'The Portfolio Desk' },
];

const TZ = 'Asia/Singapore';
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
const href = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');

const longDate = (iso) => new Intl.DateTimeFormat('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${iso}T00:00:00Z`));

const meridiem = (s) => s.replace(/\s?am\b/i, ' a.m.').replace(/\s?pm\b/i, ' p.m.');

const clock = (iso) => (iso ? meridiem(new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: TZ,
}).format(new Date(iso))) : '');

const dayClock = (iso) => (iso ? meridiem(new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
}).format(new Date(iso))) : '');

const sgDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

/** "5:02 a.m." when filed on the edition's morning or the evening before; otherwise with the day. */
const filed = (iso, editionDate) => {
  if (!iso) return '';
  const hours = (new Date(`${editionDate}T07:00:00+08:00`) - new Date(iso)) / 36e5;
  return hours >= -18 && hours <= 14 ? clock(iso) : dayClock(iso);
};

const money = (v, dp = 0) => (typeof v === 'number'
  ? `S$${v.toLocaleString('en-SG', { minimumFractionDigits: dp, maximumFractionDigits: dp })}` : '—');
const signedMoney = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}` : '—');
const pct = (v, dp = 2) => (typeof v === 'number' ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}%` : '—');
const trend = (v) => (typeof v !== 'number' || v === 0 ? '' : v > 0 ? 'up' : 'down');
const price = (v, ccy) => {
  if (typeof v !== 'number') return '—';
  const sym = { SGD: 'S$', USD: 'US$' }[ccy] ?? `${ccy ?? ''} `;
  return `${sym}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function dropcap(text) {
  const t = String(text ?? '');
  if (!/^[A-Za-z]/.test(t)) return esc(t);
  return `<span class="dropcap" aria-hidden="true">${esc(t[0])}</span><span class="sr-only" data-snap="skip">${esc(t[0])}</span>${esc(t.slice(1))}`;
}

const runner = (ed, i) => `
  <header class="runner">
    <span class="runner__folio">${PAGES[i].folio} · Section A</span>
    <span class="runner__title">The Personal Times</span>
    <span class="runner__date">${esc(longDate(ed.date))}</span>
  </header>`;

const foot = (ed, i) => `
  <footer class="page-foot">
    <span>${PAGES[i].folio}</span>
    <span>The Personal Times · No. ${esc(ed.edition_no)}</span>
    <span>${esc(longDate(ed.date))}</span>
  </footer>`;

/* ---------- A1 · The World ---------- */

function story(s, ed, lead) {
  return `
    <article class="story${lead ? ' story--lead' : ''}">
      <h3 class="story__headline"><a href="${href(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.headline)}</a></h3>
      <p class="story__byline">${esc(s.source)}${s.published ? ` · ${esc(filed(s.published, ed.date))}` : ''}</p>
      ${s.summary ? `<p class="story__summary">${lead ? dropcap(s.summary) : esc(s.summary)}</p>` : ''}
      ${s.why ? `<p class="story__why"><b>Why it matters</b> ${esc(s.why)}</p>` : ''}
    </article>`;
}

function worldPage(ed) {
  const counts = ed.inbox.counts || {};
  const m = ed.markets;
  const desks = ed.desks.map((d) => `
    <section class="desk" aria-label="${esc(d.title)}">
      <h2 class="desk__name"><span>${esc(d.title)}</span><span class="desk__count">${d.stories.length} ${d.stories.length === 1 ? 'story' : 'stories'}</span></h2>
      ${d.stories.length ? d.stories.map((s, i) => story(s, ed, i === 0)).join('') : '<p class="empty">The wires were silent this morning.</p>'}
    </section>`).join('');

  const generated = ed.generated_at ? clock(ed.generated_at) : '';
  return `
    <header class="masthead">
      <div class="masthead__top">
        <div class="ear"><span class="ear__kicker">Singapore Edition</span><span class="ear__text">World · Inbox · Markets</span></div>
        <h1 class="masthead__title">The Personal Times</h1>
        <div class="ear ear--right"><span class="ear__kicker">Morning Edition</span><span class="ear__text">Went to press ${esc(generated)}</span></div>
      </div>
      <div class="dateline">
        <span>Vol. I · No. ${esc(ed.edition_no)}</span>
        <span>${esc(longDate(ed.date))}</span>
        <span>Singapore · Beijing · Washington · The Valley</span>
      </div>
    </header>
    <section class="front-lead">
      <p class="kicker">The Morning's Lead</p>
      <h2 class="front-lead__headline">${esc(ed.front.headline)}</h2>
      <p class="front-lead__dek">${esc(ed.front.dek)}</p>
      ${ed.editor.llm ? '' : '<p class="wire-note">Wire edition — the editor’s desk was unavailable, so stories appear as filed.</p>'}
    </section>
    <div class="desks">${desks}</div>
    <nav class="inside" aria-label="Inside this edition">
      <button class="inside__item" data-goto="1">
        <span class="inside__folio">A2</span>
        <span class="inside__title">The Inbox Dispatch</span>
        <span class="inside__teaser">${counts.action ? `${counts.action} need your action` : 'Nothing needs action'}</span>
      </button>
      <button class="inside__item" data-goto="2">
        <span class="inside__folio">A3</span>
        <span class="inside__title">The Portfolio Desk</span>
        <span class="inside__teaser">${m ? `Household ${esc(money(m.household_total_sgd))}` : 'Desk unavailable'}</span>
      </button>
    </nav>`;
}

/* ---------- A2 · The Inbox Dispatch ---------- */

function letter(item, ed) {
  const deadline = item.deadline ? `<span class="deadline">Due ${esc(item.deadline)}</span>` : '';
  const action = item.action || deadline
    ? `<p class="letter__action">${item.priority === 'action' ? '<span class="stamp">Action</span>' : ''}${esc(item.action || '')}${deadline}</p>` : '';
  return `
    <article class="letter">
      <p class="letter__from">From <b>${esc(item.from_name || item.from_addr)}</b> · ${esc(filed(item.received, ed.date))}</p>
      <h3 class="letter__subject">${esc(item.subject)}</h3>
      <p class="letter__gist">${esc(item.gist)}</p>
      ${action}
      <a class="letter__open" href="${href(item.gmail_url)}" target="_blank" rel="noopener noreferrer">Open in Gmail ↗</a>
    </article>`;
}

function inboxPage(ed) {
  const inbox = ed.inbox;
  const counts = inbox.counts || { action: 0, heads_up: 0, fyi: 0 };
  const cols = [
    ['action', 'Action Required', 'Nothing requires your hand today.'],
    ['heads_up', 'Heads Up', 'No notices worth flagging.'],
    ['fyi', 'For the Record', 'Nothing else of note.'],
  ].map(([key, title, empty]) => {
    const items = inbox.items.filter((i) => i.priority === key);
    return `
      <section class="dispatch__col dispatch__col--${key}" aria-label="${title}">
        <h2 class="col-head"><span>${title}</span><span>${items.length}</span></h2>
        ${items.length ? items.map((i) => letter(i, ed)).join('') : `<p class="empty">${empty}</p>`}
      </section>`;
  }).join('');

  return `
    ${runner(ed, 1)}
    <section class="section-head">
      <div>
        <p class="kicker">Correspondence · last 24 hours</p>
        <h2 class="section-head__title">The Inbox Dispatch</h2>
      </div>
      <div>
        <p class="section-head__dek">${esc(inbox.overview)}</p>
        <ul class="tally">
          <li class="is-action"><b>${counts.action}</b>need action</li>
          <li><b>${counts.heads_up}</b>heads-up</li>
          <li><b>${counts.fyi}</b>for the record</li>
          <li><b>${inbox.scanned}</b>scanned</li>
        </ul>
      </div>
    </section>
    ${inbox.error ? `<p class="desk-error">The inbox desk couldn't reach Gmail this morning (${esc(inbox.error)}).</p>` : ''}
    <div class="dispatch">${cols}</div>`;
}

/* ---------- A3 · The Portfolio Desk ---------- */

function sparkline(history) {
  const pts = (history || []).filter((h) => typeof h.household === 'number');
  if (pts.length < 2) return '<p class="empty">Not enough history to chart yet.</p>';
  const W = 600, H = 170, pad = 8;
  const vals = pts.map((p) => p.household);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = (i) => (pad + (i * (W - 2 * pad)) / (pts.length - 1)).toFixed(1);
  const y = (v) => (H - pad - ((v - min) / span) * (H - 2 * pad * 2)).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.household)}`).join('');
  const last = pts.length - 1;
  const change = vals[last] - vals[0];
  return `
    <svg data-snap-svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="spark"
      role="img" aria-label="Household net worth from ${esc(money(vals[0]))} to ${esc(money(vals[last]))} over ${pts.length} sessions">
      <defs><pattern id="dt-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
        <line x1="0" y1="0" x2="0" y2="5" stroke="#1b1a17" stroke-width="1" stroke-opacity=".3"/></pattern></defs>
      <line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="#1b1a17" stroke-width="1"/>
      <path d="${line}L${x(last)},${H}L${x(0)},${H}Z" fill="url(#dt-hatch)"/>
      <path d="${line}" fill="none" stroke="#1b1a17" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(last)}" cy="${y(vals[last])}" r="4" fill="#9b2318"/>
    </svg>
    <div class="spark-legend">
      <span>${esc(pts[0].date)}</span>
      <span class="${trend(change)}">${esc(signedMoney(change))} · low ${esc(money(min))} · high ${esc(money(max))}</span>
      <span>${esc(pts[last].date)}</span>
    </div>`;
}

const sourceLinks = (links) => (links || []).map((l) => ` <a class="src" href="${href(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}&nbsp;↗</a>`).join('');

function newsPanel(scan) {
  const news = scan.news || [];
  if (!news.length) return '';
  const holdings = news.map((h) => `
    <article class="holding-news">
      <h4 class="holding-news__head"><span class="action__ticker">${esc(h.ticker)}</span><span class="lvl lvl--${esc(h.level)}">${esc(h.level)}</span></h4>
      <ul class="holding-news__items">${h.items.map((it) => `<li>${esc(it.text)}${sourceLinks(it.links)}</li>`).join('')}</ul>
    </article>`).join('');
  const notes = (scan.news_notes || []).map((n) => `<p class="news-note"><b>${esc(n.label)}:</b> ${esc(n.text)}${sourceLinks(n.links)}</p>`).join('');
  return `
    <section class="panel panel--news">
      <h3 class="col-head"><span>News by holding</span><span>Hermes scan · ${esc(scan.date || '')}</span></h3>
      <div class="news-list">${holdings}</div>
      ${notes}
    </section>`;
}

function marketsPage(ed) {
  const m = ed.markets;
  if (!m) {
    return `${runner(ed, 2)}
      <section class="section-head"><div><p class="kicker">Markets</p><h2 class="section-head__title">The Portfolio Desk</h2></div>
      <div><p class="section-head__dek">The portfolio desk couldn't read Mission Control this morning${ed.markets_error ? ` (${esc(ed.markets_error)})` : ''}.</p></div></section>`;
  }
  const stale = !m.markets_closed && m.age_hours > 20;
  const status = `Prices as of ${esc(dayClock(m.updated_at))} SGT · USD/SGD ${esc(m.fx_usdsgd)}${m.markets_closed ? ' · Markets closed for the weekend' : ''}`;
  const usOver = typeof m.us_equity_pct === 'number' && typeof m.us_cap_pct === 'number' && m.us_equity_pct > m.us_cap_pct;

  const goals = m.goals.map((g) => {
    const p = Math.max(0, Math.min(100, g.progress_pct || 0));
    const due = g.target_date ? new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${g.target_date}T00:00:00Z`)) : '';
    return `
      <div class="goal">
        <div class="goal__head"><span>${esc(g.name)}</span><span class="goal__pct">${p.toFixed(1)}%</span></div>
        <div class="goal__bar"><i style="width:${p}%"></i></div>
        <p class="goal__meta">${esc(money(g.current_sgd))} of ${esc(money(g.target_sgd))} · projected ${esc(money(g.projected_sgd))}${due ? ` by ${esc(due)}` : ''} ·
          <b class="${g.on_track ? 'up' : 'down'}">${g.on_track ? 'On track' : 'Behind'}</b></p>
      </div>`;
  }).join('') || '<p class="empty">No goals configured.</p>';

  const actions = m.scan.actions.map((a) => `
    <div class="action">
      <div class="action__head"><span class="lvl lvl--${esc(a.level)}">${esc(a.level)}</span><span class="action__ticker">${esc(a.ticker)}</span></div>
      <p class="action__text">${esc(a.action)}</p>
      <p class="action__why">${esc(a.why)}</p>
    </div>`).join('') || '<p class="empty">No suggested actions in the latest scan.</p>';

  const book = [...m.positions].sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0)).map((p) => `
    <tr>
      <td>${esc(p.ticker)}<span class="book-tag">${esc(p.book)}</span></td>
      <td>${esc(price(p.price, p.ccy))}</td>
      <td class="${trend(p.day_pct)}">${esc(pct(p.day_pct))}</td>
      <td class="${trend(p.pl_pct)}">${esc(pct(p.pl_pct, 1))}</td>
      <td>${esc(money(p.mv_sgd))}</td>
      <td>${typeof p.weight_pct === 'number' ? `${p.weight_pct.toFixed(1)}%` : '—'}</td>
    </tr>`).join('');

  const triggers = m.triggers.map((t) => `
    <tr>
      <td>${esc(t.ticker)}</td>
      <td>${t.type === 'below' ? '▼' : '▲'} ${esc(t.level)}</td>
      <td>${esc(t.current)}</td>
      <td class="${t.hit ? 'down' : ''}">${t.hit ? 'HIT' : esc(pct(t.distance_pct, 1))}</td>
    </tr>`).join('');

  const flags = m.flags.map((f) => `
    <p class="flag"><span class="flag__mark ${f.level === 'warn' ? 'down' : ''}">${f.level === 'warn' ? '▲' : '•'}</span> ${esc(f.msg)}</p>`).join('')
    || '<p class="empty">No standing flags.</p>';

  const movers = m.movers.slice(0, 5).map((p) => `<span class="mover"><b>${esc(p.ticker)}</b> <span class="${trend(p.day_pct)}">${esc(pct(p.day_pct))}</span></span>`).join('');

  return `
    ${runner(ed, 2)}
    <section class="section-head">
      <div>
        <p class="kicker">Markets &amp; Money</p>
        <h2 class="section-head__title">The Portfolio Desk</h2>
        <p class="section-head__lede">${esc(m.headline)}</p>
      </div>
      <div>
        <p class="section-head__dek">${esc(m.note)}</p>
        <p class="status-line">${status}${stale ? ` · <span class="warn">Data is ${Math.round(m.age_hours)}h old</span>` : ''}</p>
      </div>
    </section>
    <div class="stats">
      <div class="stat"><span class="stat__label">Household</span><span class="stat__value">${esc(money(m.household_total_sgd))}</span><span class="stat__sub">all pools, SGD</span></div>
      <div class="stat"><span class="stat__label">Brokerage book</span><span class="stat__value">${esc(money(m.direct_total_sgd))}</span><span class="stat__sub">brokerage accounts</span></div>
      <div class="stat"><span class="stat__label">Unrealised P&amp;L</span><span class="stat__value ${trend(m.pl_sgd)}">${esc(signedMoney(m.pl_sgd))}</span><span class="stat__sub">brokerage positions</span></div>
      <div class="stat"><span class="stat__label">US equity</span><span class="stat__value ${usOver ? 'down' : ''}">${typeof m.us_equity_pct === 'number' ? `${m.us_equity_pct.toFixed(1)}%` : '—'}</span><span class="stat__sub">cap ${esc(m.us_cap_pct ?? '—')}%</span></div>
      <div class="stat"><span class="stat__label">Health grade</span><span class="stat__value">${esc((m.health?.grade || '—').split(' ')[0])}</span><span class="stat__sub">${esc(m.health?.grade || '')} · ${esc(m.health?.as_of || '')}</span></div>
    </div>
    ${movers ? `<p class="movers"><span class="movers__label">Biggest moves</span>${movers}</p>` : ''}
    <div class="markets-grid">
      <section class="panel panel--chart"><h3 class="col-head"><span>Household, last ${m.history.length} sessions</span></h3>${sparkline(m.history)}</section>
      <section class="panel panel--goals"><h3 class="col-head"><span>Goals</span></h3>${goals}<p class="goal__meta">${esc(m.recommendation || '')}</p></section>
      <section class="panel panel--actions"><h3 class="col-head"><span>Suggested actions</span><span>${esc(m.scan.date || '')}</span></h3>${actions}</section>
      <section class="panel panel--book"><h3 class="col-head"><span>The Book</span><span>${m.positions.length} positions</span></h3>
        <div class="table-wrap"><table class="ledger">
          <thead><tr><th>Holding</th><th>Price</th><th>Day</th><th>P&amp;L</th><th>Value</th><th>Weight</th></tr></thead>
          <tbody>${book}</tbody></table></div></section>
      <section class="panel panel--triggers"><h3 class="col-head"><span>Trigger watch</span><span>nearest</span></h3>
        <div class="table-wrap"><table class="ledger ledger--compact">
          <thead><tr><th>Ticker</th><th>Level</th><th>Now</th><th>Away</th></tr></thead>
          <tbody>${triggers}</tbody></table></div></section>
      <section class="panel panel--flags"><h3 class="col-head"><span>Standing flags</span></h3>${flags}</section>
      ${newsPanel(m.scan)}
    </div>
    <p class="disclaimer">Figures from Portfolio Mission Control; suggested actions from the Hermes daily scan. Educational analysis, not licensed financial advice.</p>`;
}

export function renderEdition(ed) {
  return [worldPage, inboxPage, marketsPage].map((fn, i) => `
    <article class="page page--${PAGES[i].slug}" data-index="${i}" id="page-${PAGES[i].slug}" aria-label="${esc(PAGES[i].folio)} ${esc(PAGES[i].title)}" tabindex="-1">
      ${fn(ed)}
      ${foot(ed, i)}
    </article>`).join('');
}

export function renderIssues(list, currentDate) {
  return list.map((e) => `
    <li><button data-date="${esc(e.date)}" aria-current="${e.date === currentDate}">
      <span class="issues__date">${esc(e.date.slice(5).replace('-', '/'))}</span>
      <span class="issues__headline">${esc(e.headline)}</span>
      <span class="issues__no">No. ${esc(e.edition_no)} · ${esc(longDate(e.date))}</span>
    </button></li>`).join('') || '<li class="empty">This is the first edition.</li>';
}

export { esc, sgDay };
