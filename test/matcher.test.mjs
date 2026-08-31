// Pure logic only — matcher.js touches no chrome.* and no DOM, which is exactly
// why it's the part worth testing. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldRedirect,
  playlistUrl,
  parsePlaylistId,
  isYouTubeUrl,
  isCacheComplete,
  matchesTopic,
  normalizeText,
  parseList,
  suggestKeywords,
} from '../src/matcher.js';

const ID = 'PLtest123';
const TARGET = playlistUrl(ID);
const playlistMode = (playlist = {}) => ({
  enabled: true,
  mode: 'playlist',
  playlist: { id: ID, strict: true, ...playlist },
});
const topicMode = (topic = {}) => ({
  enabled: true,
  mode: 'topic',
  topic: { label: 'DSA', blockShorts: true, scopeSearch: true, ...topic },
});

test('parsePlaylistId takes a URL, a watch URL, or a bare ID', () => {
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=PLabc_-123'), 'PLabc_-123');
  assert.equal(parsePlaylistId('https://www.youtube.com/watch?v=x&list=PLabc&index=2'), 'PLabc');
  assert.equal(parsePlaylistId('PLabc'), 'PLabc');
  assert.equal(parsePlaylistId('not a url'), '');
  assert.equal(parsePlaylistId(''), '');
  assert.equal(parsePlaylistId(null), '');
});

test('isYouTubeUrl accepts youtube hosts over http(s) only', () => {
  assert.ok(isYouTubeUrl('https://www.youtube.com/'));
  assert.ok(isYouTubeUrl('https://m.youtube.com/watch?v=x'));
  assert.ok(!isYouTubeUrl('https://notyoutube.com/'));
  assert.ok(!isYouTubeUrl('chrome://extensions'));
  assert.ok(!isYouTubeUrl('gibberish'));
});

test('playlist lock allows the playlist and bounces everything else', () => {
  const settings = playlistMode();
  assert.equal(shouldRedirect('https://www.youtube.com/playlist?list=PLtest123', settings), null);
  assert.equal(shouldRedirect('https://www.youtube.com/watch?v=abc&list=PLtest123', settings), null);
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/shorts/xyz',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/@someone',
    'https://www.youtube.com/results?search_query=cats',
    'https://www.youtube.com/playlist?list=PLother',
  ]) {
    assert.equal(shouldRedirect(url, settings), TARGET, url);
  }
});

test('playlist lock never bounces a page to itself', () => {
  assert.equal(shouldRedirect(TARGET, playlistMode()), null);
});

test('strict:false gates /watch and leaves the rest of YouTube alone', () => {
  const settings = playlistMode({ strict: false });
  assert.equal(shouldRedirect('https://www.youtube.com/', settings), null);
  assert.equal(shouldRedirect('https://www.youtube.com/feed/subscriptions', settings), null);
  assert.equal(shouldRedirect('https://www.youtube.com/watch?v=abc', settings), TARGET);
  assert.equal(shouldRedirect('https://www.youtube.com/watch?v=abc&list=PLtest123', settings), null);
});

test('nothing is gated while the extension is off, or without a playlist', () => {
  assert.equal(shouldRedirect('https://www.youtube.com/', { ...playlistMode(), enabled: false }), null);
  assert.equal(shouldRedirect('https://www.youtube.com/', playlistMode({ id: '' })), null);
});

test('cache membership only bites once the scrape is provably complete', () => {
  const settings = playlistMode();
  const url = (v) => `https://www.youtube.com/watch?v=${v}&list=${ID}`;
  const complete = { id: ID, fetchedAt: Date.now(), count: 3, videoIds: ['aaa', 'bbb', 'ccc'], titles: {} };
  const partial = { ...complete, count: 50 };
  const otherPlaylist = { ...complete, id: 'PLother' };

  assert.equal(shouldRedirect(url('zzz'), settings, null), null, 'no cache');
  assert.equal(shouldRedirect(url('zzz'), settings, partial), null, 'partial scrape');
  assert.equal(shouldRedirect(url('zzz'), settings, otherPlaylist), null, 'cache for another playlist');
  assert.equal(shouldRedirect(url('bbb'), settings, complete), null, 'member');
  assert.equal(shouldRedirect(url('zzz'), settings, complete), TARGET, 'stranger');
  assert.equal(shouldRedirect(`https://www.youtube.com/watch?list=${ID}`, settings, complete), TARGET, 'no v');

  assert.ok(isCacheComplete(complete, ID));
  assert.ok(!isCacheComplete(partial, ID));
  assert.ok(!isCacheComplete(complete, 'PLother'));
  assert.ok(!isCacheComplete(null, ID));
});

test('topic mode blocks Shorts and scopes search, without looping', () => {
  assert.equal(shouldRedirect('https://www.youtube.com/shorts/abc', topicMode()), 'https://www.youtube.com/');
  assert.equal(shouldRedirect('https://www.youtube.com/shorts/abc', topicMode({ blockShorts: false })), null);
  assert.equal(shouldRedirect('https://www.youtube.com/', topicMode()), null);
  assert.equal(shouldRedirect('https://www.youtube.com/watch?v=abc', topicMode()), null);

  assert.equal(
    shouldRedirect('https://www.youtube.com/results?search_query=binary+search', topicMode()),
    'https://www.youtube.com/results?search_query=binary+search+DSA',
  );
  // Already carries the label: rewriting again would bounce forever.
  assert.equal(shouldRedirect('https://www.youtube.com/results?search_query=binary+search+dsa', topicMode()), null);
  assert.equal(shouldRedirect('https://www.youtube.com/results?search_query=cats', topicMode({ scopeSearch: false })), null);
  assert.equal(shouldRedirect('https://www.youtube.com/results?search_query=cats', topicMode({ label: '' })), null);
});

test('matchesTopic passes on a keyword in the title or an allowed channel', () => {
  const topic = { keywords: ['dsa', 'binary search'], channels: ['takeUforward'] };
  assert.ok(matchesTopic({ title: 'DSA Sheet Explained', channel: 'Random Guy' }, topic), 'casing');
  assert.ok(matchesTopic({ title: 'Binary Search — Part 2!', channel: 'Random' }, topic), 'punctuation');
  assert.ok(matchesTopic({ title: 'Cat compilation', channel: 'takeUforward' }, topic), 'channel allowlist');
  assert.ok(!matchesTopic({ title: 'Cat compilation', channel: 'Cats Daily' }, topic), 'both miss');
  assert.ok(!matchesTopic({ title: 'binarysearch tricks', channel: 'x' }, topic), 'no match across word joins');
});

test('an empty profile passes everything rather than blanking the feed', () => {
  assert.ok(matchesTopic({ title: 'anything', channel: 'anyone' }, { keywords: [], channels: [] }));
  assert.ok(matchesTopic({ title: 'anything' }, {}));
});

test('normalizeText folds punctuation but keeps c++ and c#', () => {
  assert.equal(normalizeText('C++ (Part 2)!'), 'c++ part 2');
  assert.equal(normalizeText('  Dynamic   Programming  '), 'dynamic programming');
  assert.equal(normalizeText(null), '');
});

test('parseList splits on commas and newlines, trims, de-duplicates', () => {
  assert.deepEqual(parseList(' dsa, leetcode\ndynamic programming ,, dsa '), ['dsa', 'leetcode', 'dynamic programming']);
  assert.deepEqual(parseList(''), []);
});

test('suggestKeywords ranks recurring words and drops noise', () => {
  const titles = { a: 'Graph Theory Part 1', b: 'Graph Traversal Part 2', c: 'Graph BFS' };
  const seeds = suggestKeywords(titles);
  assert.equal(seeds[0], 'graph');
  assert.ok(!seeds.includes('part'), 'stopword dropped');
  assert.ok(!seeds.includes('1'), 'bare numbers dropped');
  assert.deepEqual(suggestKeywords({}), []);
});
