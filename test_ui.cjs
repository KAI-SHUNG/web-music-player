// Optional front-end checks: node test_ui.cjs (no npm dependencies).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// Minimal browser boundary; the real page script drives all selection/state changes.
class Element {
  constructor() {
    this.children = []; this.attributes = {}; this.events = {}; this.textContent = '';
    this.value = ''; this.open = false; this.hidden = false; this.currentTime = 0;
    this.readyState = 0; this.duration = 100; this.paused = true; this.clientHeight = 160;
    this.playCalls = 0; this.scrollTop = 0;
    this.classList = { toggle: (name, on) => { this.attributes[name] = on; } };
  }
  append(child) { child.offsetTop = this.children.length * 40; this.children.push(child); }
  get firstChild() { return this.children[0]; }
  replaceChildren(...children) { this.children = []; children.forEach(c => this.append(c)); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this._src = undefined; }
  addEventListener(key, handler) { this.events[key] = handler; }
  set src(value) { this._src = value; this.currentTime = 0; this.readyState = 0; }
  get src() { return this._src; }
  scrollTo(options) { this.scrollTop = options.top; }
  load() { this.currentTime = 0; }
  async play() { this.paused = false; this.playCalls++; this.events.play?.(); }
}

async function browser(names, options = {}) {
  const ids = ['player', 'tracks', 'now', 'status', 'previous', 'next', 'refresh', 'shuffle',
    'library', 'search', 'results', 'search-status', 'lyrics', 'lyric-lines', 'lyric-status', 'notice', 'queue-status'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  let random = 0;
  const math = Object.create(Math);
  math.random = () => random;
  const storage = options.storage || new Map();
  const events = {};
  const fetches = [];
  const sandbox = {
    document: { querySelector: selector => nodes[selector.slice(1)], createElement: () => new Element() },
    localStorage: {
      getItem: key => { if (options.brokenStorage) throw Error('Blocked'); return storage.get(key) || null; },
      setItem: (key, value) => { if (options.brokenStorage) throw Error('Quota'); storage.set(key, value); },
    },
    window: { addEventListener: (key, handler) => { events[key] = handler; }, matchMedia: () => ({ matches: true }) },
    fetch: async url => {
      fetches.push(url);
      if (url === 'api/tracks') {
        if (options.trackFetch) return options.trackFetch();
        if (options.offline) throw Error('Offline');
        return { ok: true, headers: { get: () => options.libraryId || 'test-library' },
          json: async () => names.map(name => ({ name, url: '/media/' + encodeURIComponent(name) })) };
      }
      if (options.lyricFetch) return options.lyricFetch(url);
      const text = options.lyrics?.[decodeURIComponent(url.replace('/lyrics/', ''))];
      return { ok: text !== undefined, status: text === undefined ? 404 : 200, text: async () => text };
    },
    Math: math,
    console,
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, storage, events, fetches, parseLrc: sandbox.parseLrc, random: value => { random = value; } };
}

(async () => {
  const { nodes: n, random } = await browser(['A.mp3', 'B.mp3', 'C.mp3']);
  assert.equal(typeof n.shuffle.onclick, 'function', 'Random playback switch is not wired');
  await n.next.onclick();
  assert.equal(n.player.src, '/media/A.mp3');
  n.shuffle.onclick();
  assert.equal(n.shuffle.attributes['aria-pressed'], 'true');
  random(0);
  await n.next.onclick();
  assert.equal(n.player.src, '/media/B.mp3', 'Shuffle must skip the current song');
  random(0.999);
  await n.next.onclick();
  assert.equal(n.player.src, '/media/C.mp3');
  random(0);
  await n.player.events.ended();
  assert.equal(n.player.src, '/media/A.mp3', 'Automatic continuation must also shuffle');
  await n.previous.onclick();
  assert.equal(n.player.src, '/media/C.mp3', 'Previous must return to the last played song');
  assert.equal(n.now.textContent, 'C.mp3');
  assert.equal(n.tracks.children[2].firstChild.attributes['aria-current'], 'true');
  await n.refresh.onclick();
  await n.previous.onclick();
  assert.equal(n.player.src, '/media/B.mp3', 'History must survive refreshing the list');
  n.shuffle.onclick();
  assert.equal(n.shuffle.attributes['aria-pressed'], 'false');
  await n.next.onclick();
  assert.equal(n.player.src, '/media/C.mp3', 'Disabling shuffle must restore sequential play');

  const single = (await browser(['Only.mp3'])).nodes;
  single.shuffle.onclick();
  await single.next.onclick();
  await single.player.events.ended();
  assert.equal(single.player.src, '/media/Only.mp3');

  const empty = (await browser([])).nodes;
  empty.shuffle.onclick();
  await empty.next.onclick();
  assert.equal(empty.player.src, undefined);

  // A lost storage write, re-sort on reload, or automatic play would break these.
  const stateKey = 'mp3-player-state-v1';
  const originalState = JSON.stringify({ version: 1, libraryId: 'test-library',
    tracks: ['C.mp3', 'A.mp3', 'B.mp3'].map(name => ({ name, url: '/media/' + name })),
    currentUrl: '/media/B.mp3', position: 42.5, shuffle: true,
    history: ['/media/A.mp3'], query: 'B', expanded: true });
  const freshStorage = () => new Map([[stateKey, originalState]]);
  const stored = freshStorage();
  const restored = await browser(['A.mp3', 'B.mp3', 'C.mp3', 'New.mp3'], { storage: stored });
  const r = restored.nodes;
  assert.equal(r.player.src, '/media/B.mp3', 'Restore selected track');
  assert.equal(r.player.playCalls, 0, 'Refresh must not force autoplay');
  assert.equal(r.shuffle.attributes['aria-pressed'], 'true');
  assert.equal(r.search.value, 'B');
  assert.equal(r.library.open, true);
  assert.deepEqual(r.tracks.children.map(li => li.firstChild.textContent), ['C.mp3', 'A.mp3', 'B.mp3', 'New.mp3']);
  restored.events.pagehide();
  assert.equal(JSON.parse(stored.get(stateKey)).position, 42.5, 'Pending seek must survive an early refresh');
  r.player.readyState = 1;
  r.player.events.loadedmetadata();
  assert.equal(r.player.currentTime, 42.5);
  r.player.currentTime = 55;
  restored.events.pagehide();
  assert.equal(JSON.parse(stored.get(stateKey)).position, 55);
  await r.previous.onclick();
  assert.equal(r.player.src, '/media/A.mp3');
  r.search.value = 'new';
  r.search.events.input();
  assert.equal(r.results.children.length, 1);
  await r.results.children[0].firstChild.events.click();
  assert.equal(r.player.src, '/media/New.mp3', 'Filtered result must select its original track');
  r.library.open = false;
  r.library.events.toggle();
  assert.equal(JSON.parse(stored.get(stateKey)).expanded, false);

  const initial = await browser(['Only.mp3']);
  assert.equal(initial.nodes.library.open, false, 'Full list defaults to collapsed');
  assert.equal(initial.nodes.results.children.length, 0);
  const changedLibrary = await browser(['Other.mp3'], { storage: freshStorage(), libraryId: 'different-library' });
  assert.equal(changedLibrary.nodes.player.src, undefined, 'Do not restore audio from another folder');
  const removedStorage = freshStorage();
  const removed = await browser(['C.mp3'], { storage: removedStorage });
  assert.equal(removed.nodes.player.src, undefined, 'Do not retain a removed track');
  assert.equal(JSON.parse(removedStorage.get(stateKey)).currentUrl, null);
  const offline = await browser([], { storage: freshStorage(), offline: true });
  assert.ok(offline.nodes.tracks.children.length, 'Cached library must remain visible when refresh fails');
  assert.equal(offline.nodes.player.src, '/media/B.mp3');
  const blocked = await browser(['Only.mp3'], { brokenStorage: true });
  await blocked.nodes.next.onclick();
  assert.equal(blocked.nodes.player.src, '/media/Only.mp3');
  const invalid = await browser(['Safe.mp3'], { storage: new Map([[stateKey, '{broken']]) });
  assert.equal(invalid.nodes.tracks.children.length, 1);
  const hostile = await browser(['Safe.mp3'], { storage: new Map([[stateKey, JSON.stringify({ version: 1,
    tracks: [{ name: 'evil.mp3', url: 'https://example.invalid/evil.mp3' }], currentUrl: 'https://example.invalid/evil.mp3' })]]) });
  assert.equal(hostile.nodes.player.src, undefined, 'Cached state must not load remote audio');

  const lyricsText = '[offset:500]\n[00:01.00][00:03.000]first\n[00:01.00]translation\n[00:02.50]second';
  const lyricPlayer = await browser(['A.mp3', 'B.mp3'], { lyrics: { 'A.mp3': lyricsText } });
  assert.equal(typeof lyricPlayer.parseLrc, 'function', 'Timed lyrics parser is missing');
  const parsed = JSON.parse(JSON.stringify(lyricPlayer.parseLrc(lyricsText)));
  assert.deepEqual(parsed.lines, [{ time: 0.5, text: 'first\ntranslation' }, { time: 2, text: 'second' }, { time: 2.5, text: 'first' }]);
  assert.equal(lyricPlayer.parseLrc('plain lyrics').plain, 'plain lyrics');
  await lyricPlayer.nodes.next.onclick();
  await new Promise(resolve => setImmediate(resolve));
  const l = lyricPlayer.nodes;
  l.player.currentTime = 2.1;
  l.player.events.timeupdate();
  assert.equal(l['lyric-lines'].children[1].attributes.active, true);
  l.player.currentTime = 0.6;
  l.player.events.seeked();
  assert.equal(l['lyric-lines'].children[0].attributes.active, true, 'Seeking back must move lyric highlight back');
  await l.next.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(l['lyric-status'].textContent, '暂无歌词');

  let resolveOld;
  const racing = await browser(['A.mp3', 'B.mp3'], { lyricFetch: url => url.endsWith('A.mp3')
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ ok: true, text: async () => '[00:00]new song' }) });
  await racing.nodes.next.onclick();
  await racing.nodes.next.onclick();
  await new Promise(resolve => setImmediate(resolve));
  resolveOld({ ok: true, text: async () => '[00:00]old song' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(racing.nodes['lyric-lines'].children[0].textContent, 'new song', 'Late lyric response must not replace the new song');

  // A late initial refresh must never replace newer results or clear a new selection.
  const trackResponse = name => ({ ok: true, headers: { get: () => 'test-library' },
    json: async () => [{ name, url: '/media/' + name }] });
  let resolveInitial, refreshCount = 0;
  const refreshRace = await browser([], { trackFetch: () => ++refreshCount === 1
    ? new Promise(resolve => { resolveInitial = resolve; }) : Promise.resolve(trackResponse('New.mp3')) });
  await refreshRace.nodes.refresh.onclick();
  await refreshRace.nodes.tracks.children[0].firstChild.events.click();
  resolveInitial(trackResponse('Old.mp3'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshRace.nodes.player.src, '/media/New.mp3', 'Stale refresh must not clear active playback');
  assert.equal(refreshRace.nodes.tracks.children[0].firstChild.textContent, 'New.mp3');
  let rejectInitial, count = 0;
  const failedRace = await browser([], { trackFetch: () => ++count === 1
    ? new Promise((_, reject) => { rejectInitial = reject; }) : Promise.resolve(trackResponse('New.mp3')) });
  await failedRace.nodes.refresh.onclick();
  rejectInitial(Error('Stale network failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failedRace.nodes.notice.textContent, '', 'Stale failure must not overwrite a successful refresh');
  const queueTest = await browser(['A.mp3', 'B.mp3', 'C.mp3']);
  const q = queueTest.nodes;
  const queueButton = (nodes, index) => nodes.tracks.children[index].children[1];
  assert.ok(queueButton(q, 2), 'Each track needs an independent play-next button');
  await q.next.onclick();
  const callsBeforeQueue = q.player.playCalls;
  queueButton(q, 2).events.click();
  assert.equal(q.player.src, '/media/A.mp3', 'Queuing must not interrupt the current song');
  assert.equal(q.player.playCalls, callsBeforeQueue);
  assert.equal(queueButton(q, 2).textContent, '取消待播');
  assert.match(q['queue-status'].textContent, /C\.mp3/);
  q.shuffle.onclick();
  queueButton(q, 1).events.click();
  assert.deepEqual(JSON.parse(queueTest.storage.get(stateKey)).upNext, ['/media/C.mp3', '/media/B.mp3']);
  const queueSnapshot = queueTest.storage.get(stateKey);
  await q.next.onclick();
  assert.equal(q.player.src, '/media/C.mp3', 'Explicit queue must take precedence over random selection');
  await q.player.events.ended();
  assert.equal(q.player.src, '/media/B.mp3', 'Queued songs must play in insertion order');
  assert.deepEqual(JSON.parse(queueTest.storage.get(stateKey)).upNext, []);
  assert.equal(q['queue-status'].textContent, '');
  await q.next.onclick();
  assert.equal(q.player.src, '/media/A.mp3', 'Normal shuffle resumes after queue drains');

  const resumedQueue = await browser(['A.mp3', 'B.mp3', 'C.mp3'], {
    storage: new Map([[stateKey, queueSnapshot]]) });
  assert.equal(resumedQueue.nodes.player.src, '/media/A.mp3');
  assert.equal(resumedQueue.nodes.player.playCalls, 0);
  await resumedQueue.nodes.next.onclick();
  assert.equal(resumedQueue.nodes.player.src, '/media/C.mp3', 'Queue must survive a page refresh');
  await resumedQueue.nodes.next.onclick();
  assert.equal(resumedQueue.nodes.player.src, '/media/B.mp3');

  const cancel = await browser(['A.mp3', 'B.mp3', 'C.mp3']);
  await cancel.nodes.next.onclick();
  queueButton(cancel.nodes, 2).events.click();
  queueButton(cancel.nodes, 2).events.click();
  assert.deepEqual(JSON.parse(cancel.storage.get(stateKey)).upNext, [], 'Second click cancels rather than duplicates');
  await cancel.nodes.next.onclick();
  assert.equal(cancel.nodes.player.src, '/media/B.mp3');
  cancel.nodes.search.value = 'C.mp3';
  cancel.nodes.search.events.input();
  cancel.nodes.results.children[0].children[1].events.click();
  assert.deepEqual(JSON.parse(cancel.storage.get(stateKey)).upNext, ['/media/C.mp3'], 'Search result must queue the original track');
  await cancel.nodes.tracks.children[2].firstChild.events.click();
  assert.deepEqual(JSON.parse(cancel.storage.get(stateKey)).upNext, [], 'Direct selection consumes that queued song');
  await cancel.nodes.next.onclick();
  assert.equal(cancel.nodes.player.src, '/media/A.mp3');

  const libraryNames = ['A.mp3', 'B.mp3', 'C.mp3'];
  const removeQueued = await browser(libraryNames);
  queueButton(removeQueued.nodes, 2).events.click();
  libraryNames.pop();
  await removeQueued.nodes.refresh.onclick();
  assert.deepEqual(JSON.parse(removeQueued.storage.get(stateKey)).upNext, [], 'Removed queued songs must be pruned');
  const changedQueue = await browser(['A.mp3', 'B.mp3', 'C.mp3'], {
    storage: new Map([[stateKey, queueSnapshot]]), libraryId: 'different-library' });
  assert.deepEqual(JSON.parse(changedQueue.storage.get(stateKey)).upNext, [], 'Changing folders must clear old queued URLs');
  const hostileQueueState = JSON.parse(queueSnapshot);
  hostileQueueState.upNext = ['/media/C.mp3', '/media/C.mp3', 'https://example.invalid/evil.mp3', '/media/missing.mp3'];
  const safeQueue = await browser(['A.mp3', 'B.mp3', 'C.mp3'], {
    storage: new Map([[stateKey, JSON.stringify(hostileQueueState)]]) });
  assert.deepEqual(JSON.parse(safeQueue.storage.get(stateKey)).upNext, ['/media/C.mp3'], 'Restored queue must be validated and deduplicated');
  const repeatCurrent = await browser(['Only.mp3']);
  await repeatCurrent.nodes.next.onclick();
  queueButton(repeatCurrent.nodes, 0).events.click();
  const repeatRestored = await browser(['Only.mp3'], { storage: repeatCurrent.storage });
  assert.deepEqual(JSON.parse(repeatRestored.storage.get(stateKey)).upNext, ['/media/Only.mp3'], 'Restoring a paused current song must not consume its requested repeat');
  await repeatRestored.nodes.player.events.ended();
  assert.deepEqual(JSON.parse(repeatRestored.storage.get(stateKey)).upNext, []);
  console.log('PASS: existing playback/lyrics/state tests and play-next FIFO, priority, cancellation, persistence, search and reconciliation');
})().catch(error => { console.error(error); process.exitCode = 1; });
