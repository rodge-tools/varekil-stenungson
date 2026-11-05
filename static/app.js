const state = {
  direction: 'a-b',
  route: null,
  searchParams: null,
  nextPaginationReference: null,
  usedPaginationReferences: new Set(),
  journeys: [],
  nextLocalId: 0,
  lastRenderedDay: null,
  loading: false,
};

const el = {
  routeTitle: document.querySelector('#routeTitle'),
  originName: document.querySelector('#originName'),
  destinationName: document.querySelector('#destinationName'),
  swapBtn: document.querySelector('#swapBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  searchBtn: document.querySelector('#searchBtn'),
  moreBtn: document.querySelector('#moreBtn'),
  dateInput: document.querySelector('#dateInput'),
  timeInput: document.querySelector('#timeInput'),
  statusText: document.querySelector('#statusText'),
  updatedText: document.querySelector('#updatedText'),
  journeys: document.querySelector('#journeys'),
  template: document.querySelector('#journeyTemplate'),
};

function pad(n) { return String(n).padStart(2, '0'); }

function setNowInputs() {
  const d = new Date();
  el.dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  el.timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoFromInputs() {
  if (!el.dateInput.value || !el.timeInput.value) return '';
  const d = new Date(`${el.dateInput.value}T${el.timeInput.value}:00`);
  return d.toISOString();
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function localDayKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const text = d.toLocaleDateString('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function appendDaySeparatorIfNeeded(journey) {
  const key = localDayKey(journey.departure);
  if (!key || key === state.lastRenderedDay) return;

  // Visa inte en extra rubrik före den allra första dagens första resa.
  // Däremot visas rubriken direkt när listan passerar midnatt.
  if (state.lastRenderedDay !== null) {
    const divider = document.createElement('div');
    divider.className = 'day-separator';
    divider.innerHTML = `<span>${escapeHtml(fmtDay(journey.departure))}</span>`;
    el.journeys.appendChild(divider);
  }

  state.lastRenderedDay = key;
}

function durationMinutes(start, end) {
  if (!start || !end) return null;
  return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
}

function showSkeletons() {
  el.journeys.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
}

function setRouteLabels(origin, destination) {
  el.originName.textContent = origin.name;
  el.destinationName.textContent = destination.name;
  el.routeTitle.textContent = `${origin.name.split(',')[0]} → ${destination.name.split(',')[0]}`;
}

function renderJourney(journey) {
  const node = el.template.content.cloneNode(true);
  node.querySelector('.dep-time').textContent = fmtTime(journey.departure);
  node.querySelector('.arr-time').textContent = fmtTime(journey.arrival);

  const mins = durationMinutes(journey.departure, journey.arrival);
  node.querySelector('.duration').textContent = mins == null ? '' : `⏱ ${mins} min`;
  node.querySelector('.changes').textContent = journey.changes === 0 ? 'Direkt' : `${journey.changes} byte${journey.changes > 1 ? 'n' : ''}`;

  const badges = node.querySelector('.line-list');
  [...new Set(journey.lines)].forEach(line => {
    const b = document.createElement('span');
    b.className = 'line-badge';
    b.textContent = line;
    badges.appendChild(b);
  });

  const legs = node.querySelector('.legs');
  journey.legs.forEach(leg => {
    const row = document.createElement('div');
    row.className = 'leg';
    const label = leg.isTransport
      ? `${leg.mode === 'bus' ? '🚌' : '🚍'} Linje ${leg.line || '?'}${leg.direction ? ` mot ${leg.direction}` : ''}`
      : '🚶 Gång';
    row.innerHTML = `
      <div class="leg-time">${fmtTime(leg.departure)}</div>
      <div class="leg-body">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(leg.origin)} → ${escapeHtml(leg.destination)}</small>
        <small>Ankomst ${fmtTime(leg.arrival)}</small>
      </div>`;
    legs.appendChild(row);
  });
  return node;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function mergeJourneys(current, incoming) {
  const byKey = new Map(current.map(j => [j.viewKey, j]));
  incoming.forEach(j => {
    // Without a reliable identity, preserve both alternatives.
    const viewKey = j.key ? `journey:${j.key}` : `unknown:${state.nextLocalId++}`;
    byKey.set(viewKey, { ...j, viewKey });
  });
  const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
  return [...byKey.values()].sort((a, b) =>
    (timestamp(a.departure) - timestamp(b.departure)) ||
    (timestamp(a.arrival) - timestamp(b.arrival)) ||
    (a.viewKey < b.viewKey ? -1 : a.viewKey > b.viewKey ? 1 : 0)
  );
}

function renderJourneys({ preservePosition = false } = {}) {
  const cards = [...el.journeys.querySelectorAll('[data-journey-key]')];
  const openKeys = new Set(cards.filter(card => card.querySelector('details').open)
    .map(card => card.dataset.journeyKey));
  const focusedKey = document.activeElement?.closest('[data-journey-key]')?.dataset.journeyKey;
  const anchor = preservePosition && cards.find(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  let newAnchor = null;

  el.journeys.innerHTML = '';
  state.lastRenderedDay = null;
  state.journeys.forEach(j => {
    appendDaySeparatorIfNeeded(j);
    const node = renderJourney(j);
    const card = node.querySelector('.journey-card');
    card.dataset.journeyKey = j.viewKey;
    card.querySelector('details').open = openKeys.has(j.viewKey);
    el.journeys.appendChild(node);
    if (j.viewKey === focusedKey) card.querySelector('summary').focus({ preventScroll: true });
    if (anchor && j.viewKey === anchor.dataset.journeyKey) newAnchor = card;
  });
  if (!state.journeys.length) {
    el.journeys.innerHTML = '<div class="empty-card">Inga resor hittades för vald tid.</div>';
  }
  if (newAnchor) window.scrollBy(0, newAnchor.getBoundingClientRect().top - anchorTop);
}

function setLoading(loading) {
  state.loading = loading;
  [el.moreBtn, el.searchBtn, el.swapBtn, el.refreshBtn, el.dateInput, el.timeInput]
    .forEach(control => { control.disabled = loading; });
}

async function loadJourneys({ append = false, resetToNow = false } = {}) {
  if (state.loading || (append && !state.nextPaginationReference)) return;
  setLoading(true);

  if (resetToNow) setNowInputs();
  if (!append) {
    state.searchParams = null;
    state.nextPaginationReference = null;
    state.usedPaginationReferences.clear();
    state.journeys = [];
    state.nextLocalId = 0;
    showSkeletons();
    el.statusText.textContent = 'Hämtar avgångar…';
    el.moreBtn.hidden = true;
  }

  try {
    if (!append) {
      state.searchParams = new URLSearchParams({
        direction: state.direction,
        limit: '10',
        dateTime: isoFromInputs() || new Date().toISOString(),
      });
    }
    const params = new URLSearchParams(state.searchParams);
    const requestedReference = append ? state.nextPaginationReference : null;
    if (requestedReference) params.set('paginationReference', requestedReference);
    const res = await fetch(`/api/journeys?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Kunde inte hämta avgångar.');
    if (!Array.isArray(data.results)) throw new Error('Ogiltigt svar från Västtrafik.');

    const paginationSupported = Object.hasOwn(data, 'nextPaginationReference');
    const nextReference = data.nextPaginationReference ?? null;
    if (nextReference !== null && (typeof nextReference !== 'string' || !nextReference)) {
      throw new Error('Ogiltig pagineringsreferens från Västtrafik.');
    }

    setRouteLabels(data.origin, data.destination);
    state.route = data;
    const previousCount = state.journeys.length;
    state.journeys = mergeJourneys(state.journeys, data.results);
    renderJourneys({ preservePosition: append });

    if (requestedReference) state.usedPaginationReferences.add(requestedReference);
    const repeatedReference = nextReference !== null && state.usedPaginationReferences.has(nextReference);
    state.nextPaginationReference = repeatedReference ? null : nextReference;
    el.moreBtn.hidden = !state.nextPaginationReference;
    el.moreBtn.textContent = 'Visa fler avgångar';
    const added = state.journeys.length - previousCount;
    el.statusText.textContent = append
      ? `${added} nya reseförslag, ${state.journeys.length} totalt`
      : `${state.journeys.length} reseförslag`;
    if (repeatedReference) {
      el.statusText.textContent = 'Bläddringen upprepades. Uppdatera för att söka igen.';
    } else if (!paginationSupported) {
      el.statusText.textContent = 'Servern behöver uppdateras för att visa fler avgångar.';
    } else if (!nextReference && state.journeys.length) {
      el.statusText.textContent += ' · Inga fler reseförslag';
    } else if (append && !added && nextReference) {
      el.statusText.textContent += ' · Det går att bläddra vidare';
    }
    el.updatedText.textContent = `Uppdaterad ${new Date().toLocaleTimeString('sv-SE', {hour:'2-digit', minute:'2-digit'})}`;
  } catch (err) {
    if (!append) el.journeys.innerHTML = `<div class="error-card"><strong>Kunde inte hämta tider.</strong><br>${escapeHtml(err.message)}</div>`;
    el.statusText.textContent = append ? `Kunde inte hämta fler resor: ${err.message}` : 'Fel vid hämtning';
    el.moreBtn.hidden = !append || !state.nextPaginationReference;
    if (append) el.moreBtn.textContent = 'Försök igen';
  } finally {
    setLoading(false);
  }
}

el.swapBtn.addEventListener('click', () => {
  if (state.loading) return;
  state.direction = state.direction === 'a-b' ? 'b-a' : 'a-b';
  loadJourneys();
});
el.refreshBtn.addEventListener('click', () => {
  if (state.loading) return;
  loadJourneys({ resetToNow: true });
});
el.searchBtn.addEventListener('click', () => {
  if (state.loading) return;
  loadJourneys();
});
el.moreBtn.addEventListener('click', () => loadJourneys({ append: true }));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

setNowInputs();
loadJourneys();
