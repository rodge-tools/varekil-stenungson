const state = {
  direction: 'a-b',
  route: null,
  lastArrival: null,
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

async function loadJourneys({ append = false, resetToNow = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  el.moreBtn.disabled = true;
  el.searchBtn.disabled = true;

  if (resetToNow) setNowInputs();
  if (!append) {
    showSkeletons();
    el.statusText.textContent = 'Hämtar avgångar…';
    el.moreBtn.hidden = true;
  }

  try {
    let dateTime = append && state.lastArrival ? new Date(new Date(state.lastArrival).getTime() + 60000).toISOString() : isoFromInputs();
    const params = new URLSearchParams({ direction: state.direction, limit: '10' });
    if (dateTime) params.set('dateTime', dateTime);
    const res = await fetch(`/api/journeys?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Kunde inte hämta avgångar.');

    setRouteLabels(data.origin, data.destination);
    state.route = data;

    if (!append) {
      el.journeys.innerHTML = '';
      state.lastRenderedDay = null;
    }
    if (!data.results.length && !append) {
      el.journeys.innerHTML = '<div class="empty-card">Inga resor hittades för vald tid.</div>';
    } else {
      data.results.forEach(j => {
        appendDaySeparatorIfNeeded(j);
        el.journeys.appendChild(renderJourney(j));
      });
    }

    const last = data.results[data.results.length - 1];
    if (last?.arrival) state.lastArrival = last.arrival;
    el.moreBtn.hidden = data.results.length === 0;
    el.statusText.textContent = `${data.results.length} reseförslag${append ? ' tillagda' : ''}`;
    el.updatedText.textContent = `Uppdaterad ${new Date().toLocaleTimeString('sv-SE', {hour:'2-digit', minute:'2-digit'})}`;
  } catch (err) {
    if (!append) el.journeys.innerHTML = `<div class="error-card"><strong>Kunde inte hämta tider.</strong><br>${escapeHtml(err.message)}</div>`;
    el.statusText.textContent = 'Fel vid hämtning';
    el.moreBtn.hidden = true;
  } finally {
    state.loading = false;
    el.moreBtn.disabled = false;
    el.searchBtn.disabled = false;
  }
}

el.swapBtn.addEventListener('click', () => {
  state.direction = state.direction === 'a-b' ? 'b-a' : 'a-b';
  state.lastArrival = null;
  loadJourneys();
});
el.refreshBtn.addEventListener('click', () => {
  state.lastArrival = null;
  loadJourneys({ resetToNow: true });
});
el.searchBtn.addEventListener('click', () => {
  state.lastArrival = null;
  loadJourneys();
});
el.moreBtn.addEventListener('click', () => loadJourneys({ append: true }));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

setNowInputs();
loadJourneys();
