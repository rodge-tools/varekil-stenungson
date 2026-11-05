const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

process.env.TZ = 'Europe/Stockholm';
const root = path.join(__dirname, '..', 'static');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const journey = (key, departure = '2026-11-05T10:00:00+01:00', arrival = '2026-11-05T11:00:00+01:00') => ({
  key, departure, arrival, changes: 0, lines: ['2'], legs: [],
});

function setup(t) {
  const dom = new JSDOM(html, { url: 'https://example.test', runScripts: 'outside-only' });
  const pending = [], requests = [];
  dom.window.scrollBy = () => {};
  dom.window.fetch = url => {
    requests.push(new URL(url, dom.window.location.href));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  dom.window.eval(script);
  const document = dom.window.document;
  const $ = selector => document.querySelector(selector);
  t.after(() => { dom.window.close(); assert.equal(pending.length, 0, 'No unfinished requests'); });
  return {
    $, requests, document,
    click(id) { $(id).dispatchEvent(new dom.window.Event('click')); },
    keys() { return Array.from(document.querySelectorAll('.journey-card'), c => c.dataset.journeyKey); },
    async reply(results, reference = null, status = 200, legacy = false) {
      const body = { results, origin: { name: 'Varekil' }, destination: { name: 'Stenungsön' } };
      if (!legacy) body.nextPaginationReference = reference;
      pending.shift().resolve({ ok: status === 200, json: async () => body });
      await new Promise(resolve => setImmediate(resolve));
    },
    async fail() {
      pending.shift().reject(new Error('Nätverksfel'));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('overlapping trips use opaque cursor and frozen dateTime, direction and limit', async t => {
  const app = setup(t);
  await app.reply([journey('a')], 'opaque+/=% value');
  app.$('#dateInput').value = '2026-12-01';
  app.$('#timeInput').value = '15:00';
  app.click('#moreBtn');
  await app.reply([journey('b', '2026-11-05T10:30:00+01:00')]);
  assert.deepEqual(app.keys(), ['journey:a', 'journey:b']);
  const [first, second] = app.requests;
  for (const key of ['dateTime', 'direction', 'limit']) {
    assert.equal(second.searchParams.get(key), first.searchParams.get(key));
  }
  assert.equal(second.searchParams.get('paginationReference'), 'opaque+/=% value');
  assert.equal(app.$('#moreBtn').hidden, true);
});

test('duplicate realtime updates replace data, sort and preserve expanded details and focus', async t => {
  const app = setup(t);
  await app.reply([journey('a'), journey('b')], 'p1');
  app.$('[data-journey-key="journey:a"] details').open = true;
  app.$('[data-journey-key="journey:a"] summary').focus();
  app.click('#moreBtn');
  await app.reply([journey('a', '2026-11-05T10:12:00+01:00')]);
  assert.deepEqual(app.keys(), ['journey:b', 'journey:a']);
  assert.equal(app.$('[data-journey-key="journey:a"] .dep-time').textContent, '10:12');
  assert.equal(app.$('[data-journey-key="journey:a"] details').open, true);
  assert.equal(app.document.activeElement.closest('.journey-card').dataset.journeyKey, 'journey:a');
  assert.match(app.$('#statusText').textContent, /0 nya reseförslag/);
});

test('unknown identities stay separate and equal-time distinct journeys are retained across pages', async t => {
  const app = setup(t);
  await app.reply([journey(null), journey(null), journey('a')], 'p1');
  app.click('#moreBtn');
  await app.reply([journey('b')]);
  assert.equal(app.keys().length, 4);
  assert.ok(app.keys().includes('journey:a'));
  assert.ok(app.keys().includes('journey:b'));
});

test('out-of-order pages across midnight rebuild date separators and preserve duration', async t => {
  const app = setup(t);
  await app.reply([
    journey('tomorrow', '2026-11-06T00:05:00+01:00', '2026-11-06T00:35:00+01:00'),
    journey('night', '2026-11-05T23:40:00+01:00', '2026-11-06T00:20:00+01:00'),
  ], 'p1');
  app.click('#moreBtn');
  await app.reply([journey('late', '2026-11-05T23:55:00+01:00', '2026-11-06T00:30:00+01:00')]);
  assert.deepEqual(Array.from(app.$('#journeys').children, c => c.dataset.journeyKey || 'separator'),
    ['journey:night', 'journey:late', 'separator', 'journey:tomorrow']);
  assert.match(app.$('.day-separator').textContent, /6 november/);
  assert.match(app.$('[data-journey-key="journey:night"] .duration').textContent, /40 min/);
});

test('DST transitions use actual instants and full-date durations', async t => {
  const app = setup(t);
  await app.reply([
    journey('later', '2026-10-25T02:15:00+01:00', '2026-10-25T02:45:00+01:00'),
    journey('earlier', '2026-10-25T02:50:00+02:00', '2026-10-25T02:20:00+01:00'),
    journey('spring', '2026-03-29T01:50:00+01:00', '2026-03-29T03:20:00+02:00'),
  ]);
  assert.deepEqual(app.keys(), ['journey:spring', 'journey:earlier', 'journey:later']);
  assert.match(app.$('[data-journey-key="journey:earlier"] .duration').textContent, /30 min/);
  assert.match(app.$('[data-journey-key="journey:spring"] .duration').textContent, /30 min/);
});

test('empty and duplicate-only pages keep continuation while a next cursor exists', async t => {
  const app = setup(t);
  await app.reply([], 'p1');
  assert.equal(app.$('#moreBtn').hidden, false);
  app.click('#moreBtn');
  await app.reply([journey('a')], 'p2');
  app.click('#moreBtn');
  await app.reply([journey('a')], 'p3');
  assert.deepEqual(app.keys(), ['journey:a']);
  assert.equal(app.$('#moreBtn').hidden, false);
  app.click('#moreBtn');
  await app.reply([]);
  assert.equal(app.$('#moreBtn').hidden, true);
});

test('network failure, upstream error and malformed cursor preserve list and retry the same page', async t => {
  const app = setup(t);
  await app.reply([journey('a')], 'p1');
  app.click('#moreBtn');
  await app.fail();
  assert.deepEqual(app.keys(), ['journey:a']);
  assert.equal(app.$('#moreBtn').textContent, 'Försök igen');
  app.click('#moreBtn');
  await app.reply([], null, 502);
  assert.deepEqual(app.keys(), ['journey:a']);
  app.click('#moreBtn');
  await app.reply([journey('invalid')], {});
  assert.deepEqual(app.keys(), ['journey:a']);
  app.click('#moreBtn');
  await app.reply([journey('b')]);
  assert.deepEqual(app.keys(), ['journey:a', 'journey:b']);
  assert.equal(new Set(app.requests.slice(1).map(r => r.href)).size, 1);
});

test('repeated cursor cycle stops after merging final page', async t => {
  const app = setup(t);
  await app.reply([journey('a')], 'p1');
  app.click('#moreBtn');
  await app.reply([journey('b')], 'p2');
  app.click('#moreBtn');
  await app.reply([journey('c')], 'p1');
  assert.equal(app.keys().length, 3);
  assert.equal(app.$('#moreBtn').hidden, true);
  assert.match(app.$('#statusText').textContent, /upprepades/);
  app.click('#moreBtn');
  assert.equal(app.requests.length, 3);
});

test('in-flight controls and handlers cannot change direction or issue duplicate fetches', async t => {
  const app = setup(t);
  for (const id of ['#swapBtn', '#refreshBtn', '#searchBtn', '#moreBtn']) {
    assert.equal(app.$(id).disabled, true);
    app.click(id);
  }
  assert.equal(app.requests.length, 1);
  await app.reply([journey('a')], 'p1');
  app.click('#moreBtn');
  app.click('#moreBtn');
  app.click('#swapBtn');
  await app.reply([journey('b')]);
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].searchParams.get('direction'), 'a-b');
});

test('new direction and new search reset results, cursor history and query', async t => {
  const app = setup(t);
  await app.reply([journey('a')], 'p1');
  app.click('#moreBtn');
  await app.reply([journey('b')], 'p2');
  app.click('#swapBtn');
  await app.reply([journey('reverse')], 'p1');
  assert.deepEqual(app.keys(), ['journey:reverse']);
  assert.equal(app.$('#moreBtn').hidden, false);
  assert.equal(app.requests[2].searchParams.get('direction'), 'b-a');
  assert.equal(app.requests[2].searchParams.has('paginationReference'), false);
  app.$('#dateInput').value = '2026-12-01';
  app.$('#timeInput').value = '15:00';
  app.click('#searchBtn');
  await app.reply([journey('new')]);
  assert.deepEqual(app.keys(), ['journey:new']);
  assert.equal(app.requests[3].searchParams.get('dateTime'), '2026-12-01T14:00:00.000Z');
  assert.equal(app.requests[3].searchParams.has('paginationReference'), false);
});

test('old backend shows results without enabling unsafe pagination', async t => {
  const app = setup(t);
  await app.reply([journey('a')], null, 200, true);
  assert.deepEqual(app.keys(), ['journey:a']);
  assert.equal(app.$('#moreBtn').hidden, true);
  assert.match(app.$('#statusText').textContent, /Servern behöver uppdateras/);
});

test('first-page failure releases controls and allows a fresh search', async t => {
  const app = setup(t);
  await app.fail();
  assert.ok(app.$('.error-card'));
  assert.equal(app.$('#swapBtn').disabled, false);
  assert.equal(app.$('#moreBtn').hidden, true);
  app.click('#searchBtn');
  await app.reply([journey('recovered')]);
  assert.deepEqual(app.keys(), ['journey:recovered']);
});
