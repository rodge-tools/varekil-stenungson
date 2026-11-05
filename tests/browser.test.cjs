const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

let browser, server, baseURL;
before(async () => {
  const root = path.join(__dirname, '..', 'static');
  const files = {
    '/': ['index.html', 'text/html'],
    '/static/app.js': ['app.js', 'text/javascript'],
    '/static/styles.css': ['styles.css', 'text/css'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  };
  server = http.createServer((req, res) => {
    const file = files[new URL(req.url, 'http://localhost').pathname];
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file[1]);
    res.end(fs.readFileSync(path.join(root, file[0])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

const journey = (key, departure = '2026-11-05T10:00:00+01:00', arrival = '2026-11-05T11:00:00+01:00') => ({
  key, departure, arrival, changes: 0, lines: ['2'],
  legs: [{ departure, arrival, origin: 'Varekil', destination: 'Stenungsön',
    line: '2', mode: 'bus', isTransport: true }],
});
const response = (results, nextPaginationReference = null) => ({
  results, nextPaginationReference,
  origin: { name: 'Varekil' }, destination: { name: 'Stenungsön' },
});
const ready = page => page.waitForFunction(() => !document.querySelector('#searchBtn').disabled);
const keys = page => page.locator('.journey-card').evaluateAll(cards => cards.map(c => c.dataset.journeyKey));

async function openApp(t, responses, { wait = true } = {}) {
  const context = await browser.newContext({
    timezoneId: 'Europe/Stockholm', viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/journeys?*', async route => {
    requests.push(new URL(route.request().url()));
    const next = responses.shift();
    if (!next) {
      errors.push('Unexpected API request');
      await route.abort();
    } else if (typeof next === 'function') {
      await next(route);
    } else {
      await route.fulfill({ json: next });
    }
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'No browser errors or unexpected API calls');
    assert.equal(responses.length, 0, 'All expected API responses consumed');
  });
  await page.goto(baseURL);
  if (wait) await ready(page);
  return { page, requests };
}

async function more(page) {
  await page.locator('#moreBtn').click();
  await ready(page);
}

test('overlapping trips use cursor and original search parameters, even if inputs change', async t => {
  const { page, requests } = await openApp(t, [
    response([journey('a')], 'opaque+/=% value'),
    response([journey('b', '2026-11-05T10:30:00+01:00')]),
  ]);
  await page.locator('#dateInput').fill('2026-12-01');
  await page.locator('#timeInput').fill('15:00');
  await more(page);
  assert.deepEqual(await keys(page), ['journey:a', 'journey:b']);
  assert.equal(requests[1].searchParams.get('paginationReference'), 'opaque+/=% value');
  for (const param of ['dateTime', 'direction', 'limit']) {
    assert.equal(requests[1].searchParams.get(param), requests[0].searchParams.get(param));
  }
  assert.equal(await page.locator('#moreBtn').isVisible(), false);
});

test('duplicate updates replace old data; equal departure alternatives remain', async t => {
  const { page } = await openApp(t, [
    response([journey('a'), journey('b')], 'p1'),
    response([journey('a', '2026-11-05T10:12:00+01:00')]),
  ]);
  assert.equal(await page.locator('.journey-card').count(), 2);
  await page.locator('.journey-card').first().locator('summary').click();
  await more(page);
  assert.deepEqual(await keys(page), ['journey:b', 'journey:a']);
  const updated = page.locator('[data-journey-key="journey:a"]');
  assert.equal(await updated.locator('.dep-time').textContent(), '10:12');
  assert.equal(await updated.locator('details').getAttribute('open'), '');
  assert.match(await page.locator('#statusText').textContent(), /0 nya reseförslag/);
});

test('missing identities are not collapsed', async t => {
  const { page } = await openApp(t, [response([journey(null), journey(null)])]);
  assert.equal(await page.locator('.journey-card').count(), 2);
});

test('unsorted pages merge around midnight with one date separator and correct duration', async t => {
  const night = journey('night', '2026-11-05T23:40:00+01:00', '2026-11-06T00:20:00+01:00');
  const { page, requests } = await openApp(t, [
    response([journey('tomorrow', '2026-11-06T00:05:00+01:00', '2026-11-06T00:35:00+01:00'), night], 'p1'),
    response([journey('late', '2026-11-05T23:55:00+01:00', '2026-11-06T00:30:00+01:00')]),
  ]);
  await more(page);
  assert.deepEqual(await keys(page), ['journey:night', 'journey:late', 'journey:tomorrow']);
  assert.equal(await page.locator('.day-separator').count(), 1);
  assert.match(await page.locator('.day-separator').textContent(), /6 november/);
  assert.equal(await page.locator('.journeys > *').evaluateAll(nodes => nodes.map(n =>
    n.dataset.journeyKey || 'separator')).then(v => v.join(',')),
  'journey:night,journey:late,separator,journey:tomorrow');
  assert.match(await page.locator('[data-journey-key="journey:night"] .duration').textContent(), /40 min/);
  assert.equal(requests[1].searchParams.get('dateTime'), requests[0].searchParams.get('dateTime'));
});

test('DST fallback sorts actual instants instead of clock strings', async t => {
  const { page } = await openApp(t, [response([
    journey('later', '2026-10-25T02:15:00+01:00', '2026-10-25T02:45:00+01:00'),
    journey('earlier', '2026-10-25T02:50:00+02:00', '2026-10-25T02:20:00+01:00'),
  ])]);
  assert.deepEqual(await keys(page), ['journey:earlier', 'journey:later']);
  assert.match(await page.locator('.journey-card').first().locator('.duration').textContent(), /30 min/);
  assert.equal(await page.locator('.day-separator').count(), 0);
});

test('empty and duplicate-only pages can continue until the cursor ends', async t => {
  const { page } = await openApp(t, [
    response([journey('a')], 'p1'), response([], 'p2'),
    response([journey('a')], 'p3'), response([journey('b')]),
  ]);
  await more(page);
  assert.equal(await page.locator('#moreBtn').isVisible(), true);
  await more(page);
  assert.equal(await page.locator('.journey-card').count(), 1);
  assert.equal(await page.locator('#moreBtn').isVisible(), true);
  await more(page);
  assert.equal(await page.locator('.journey-card').count(), 2);
  assert.equal(await page.locator('#moreBtn').isVisible(), false);
});

test('empty first page with cursor still offers continuation', async t => {
  const { page } = await openApp(t, [response([], 'p1'), response([journey('a')])]);
  assert.equal(await page.locator('.empty-card').count(), 1);
  await more(page);
  assert.equal(await page.locator('.journey-card').count(), 1);
});

test('network and upstream failures retain list and retry exactly the same cursor', async t => {
  const { page, requests } = await openApp(t, [
    response([journey('a')], 'p1'), route => route.abort('failed'),
    route => route.fulfill({ status: 502, json: { error: 'Tillfälligt fel' } }),
    response([journey('b')]),
  ]);
  await more(page);
  assert.deepEqual(await keys(page), ['journey:a']);
  assert.equal(await page.locator('#moreBtn').textContent(), 'Försök igen');
  await more(page);
  assert.deepEqual(await keys(page), ['journey:a']);
  await more(page);
  assert.deepEqual(await keys(page), ['journey:a', 'journey:b']);
  assert.equal(requests[1].href, requests[2].href);
  assert.equal(requests[2].href, requests[3].href);
});

test('a repeating cursor cycle stops without dropping the last returned results', async t => {
  const { page, requests } = await openApp(t, [
    response([journey('a')], 'p1'), response([journey('b')], 'p2'),
    response([journey('c')], 'p1'),
  ]);
  await more(page);
  await more(page);
  assert.equal(await page.locator('.journey-card').count(), 3);
  assert.equal(await page.locator('#moreBtn').isVisible(), false);
  assert.match(await page.locator('#statusText').textContent(), /upprepades/);
  assert.equal(requests.length, 3);
});

test('direction and refresh events cannot mutate an in-flight search', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { page, requests } = await openApp(t, [
    async route => { await held; await route.fulfill({ json: response([journey('a')], 'p1') }); },
    response([journey('b')]),
  ], { wait: false });
  try {
    assert.equal(await page.locator('#swapBtn').isDisabled(), true);
    assert.equal(await page.locator('#refreshBtn').isDisabled(), true);
    await page.evaluate(() => {
      for (const id of ['swapBtn', 'refreshBtn', 'searchBtn', 'moreBtn']) {
        document.getElementById(id).dispatchEvent(new Event('click'));
      }
    });
  } finally { release(); }
  await ready(page);
  await more(page);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get('direction'), 'a-b');
  assert.equal(requests[1].searchParams.get('paginationReference'), 'p1');
});

test('new direction clears old journeys, cursor history and frozen query', async t => {
  const { page, requests } = await openApp(t, [
    response([journey('a')], 'p1'), response([journey('b')], 'p2'),
    response([journey('reverse')], 'p1'), response([journey('reverse-next')]),
  ]);
  await more(page);
  await page.locator('#swapBtn').click();
  await ready(page);
  assert.deepEqual(await keys(page), ['journey:reverse']);
  assert.equal(requests[2].searchParams.get('direction'), 'b-a');
  assert.equal(requests[2].searchParams.has('paginationReference'), false);
  assert.equal(await page.locator('#moreBtn').isVisible(), true);
  await more(page);
  assert.equal(requests[3].searchParams.get('direction'), 'b-a');
  assert.equal(requests[3].searchParams.get('paginationReference'), 'p1');
});

test('old backend displays results but does not enable unsafe time-based pagination', async t => {
  const oldResponse = response([journey('a')]);
  delete oldResponse.nextPaginationReference;
  const { page } = await openApp(t, [oldResponse]);
  assert.equal(await page.locator('.journey-card').count(), 1);
  assert.equal(await page.locator('#moreBtn').isVisible(), false);
  assert.match(await page.locator('#statusText').textContent(), /Servern behöver uppdateras/);
});

test('invalid page response can be retried without changing existing cards', async t => {
  const { page } = await openApp(t, [
    response([journey('a')], 'p1'), response([journey('bad')], {}), response([journey('b')]),
  ]);
  await more(page);
  assert.deepEqual(await keys(page), ['journey:a']);
  await more(page);
  assert.deepEqual(await keys(page), ['journey:a', 'journey:b']);
});

test('re-render preserves expanded cards, focused details and visible scroll anchor', async t => {
  const journeys = Array.from({ length: 12 }, (_, i) => journey(`a${String(i).padStart(2, '0')}`));
  const { page } = await openApp(t, [response(journeys, 'p1'), response([
    journey('early', '2026-11-05T09:50:00+01:00'),
  ])]);
  const card = page.locator('[data-journey-key="journey:a07"]');
  await card.locator('summary').click();
  await card.locator('summary').focus();
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  const top = (await card.boundingBox()).y;
  // Trigger pagination without scrolling down to the button, as an accessibility action could.
  await page.locator('#moreBtn').dispatchEvent('click');
  await ready(page);
  assert.equal(await card.locator('details').getAttribute('open'), '');
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-journey-key]')?.dataset.journeyKey), 'journey:a07');
  assert.ok(Math.abs((await card.boundingBox()).y - top) < 2, 'Visible card keeps its viewport position');
});
