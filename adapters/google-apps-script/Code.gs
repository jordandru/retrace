/**
 * Retrace — Google Docs / Drive forwarder (Google Apps Script)
 * Polls the Drive Activity API for changes on your files (optionally one folder), resolves who did it,
 * and forwards the raw activity to your Retrace server (POST /hooks/gdrive), where it is mapped to
 * who / what / when / where / why / how events. Runs under YOUR Google account — no OAuth app to register.
 *
 * Setup (5 minutes)
 *   1. script.google.com → New project → paste this file.
 *   2. Left bar "Services" (+) → add "Drive Activity API" (identifier DriveActivity) and "Peopleapi" (identifier People).
 *   3. Project Settings → Script properties → add:
 *        RETRACE_URL      https://retrace-api.<you>.workers.dev   (or your tunnel to retrace-serve)
 *        RETRACE_TOKEN    <your RETRACE_TOKEN>                     (leave empty if the server has no token)
 *        RETRACE_PROJECT  boxing-rpg                                (project name to log under)
 *        RETRACE_FOLDER   <folder id>                               (optional: only watch this folder tree)
 *   4. Run `setup` once (authorize when prompted). It backfills the last RETRACE_BACKFILL_DAYS (default 7) and installs
 *      a trigger that runs `poll` every 5 minutes. Run `stop` to remove the trigger.
 *
 * Notes: Drive Activity is delayed by up to a few minutes and aggregates rapid edits into ranges. Retrace dedupes,
 * so re-running poll/backfill is safe. Comment TEXT is not included by Google's activity API — only that a comment happened.
 */

var PROPS = PropertiesService.getScriptProperties();
var CFG = {
  url: (PROPS.getProperty('RETRACE_URL') || '').replace(/\/$/, ''),
  token: PROPS.getProperty('RETRACE_TOKEN') || '',
  project: PROPS.getProperty('RETRACE_PROJECT') || 'google-drive',
  folder: PROPS.getProperty('RETRACE_FOLDER') || '',
  backfillDays: Number(PROPS.getProperty('RETRACE_BACKFILL_DAYS') || 7),
};

function setup() {
  if (!CFG.url) throw new Error('Set RETRACE_URL in Script properties first');
  stop();
  var since = new Date(Date.now() - CFG.backfillDays * 86400000).toISOString();
  PROPS.setProperty('RETRACE_CURSOR', since);
  var n = poll();
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(5).create();
  Logger.log('Retrace: backfilled ' + n + ' activities since ' + since + '; polling every 5 min → ' + CFG.url);
}

function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t); });
}

/** Fetch activities newer than the cursor and forward them. Returns number of activities forwarded. */
function poll() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) return 0;
  try {
    var cursor = PROPS.getProperty('RETRACE_CURSOR') || new Date(Date.now() - 86400000).toISOString();
    var req = { filter: 'time >= "' + cursor + '"', pageSize: 100 };
    if (CFG.folder) req.ancestorName = 'items/' + CFG.folder;
    var all = [], pageToken = null, newest = cursor;
    do {
      if (pageToken) req.pageToken = pageToken;
      var res = DriveActivity.Activity.query(req);
      (res.activities || []).forEach(function (a) {
        all.push(a);
        var t = a.timestamp || (a.timeRange && a.timeRange.endTime);
        if (t && t > newest) newest = t;
      });
      pageToken = res.nextPageToken;
    } while (pageToken && all.length < 1000);
    if (!all.length) return 0;
    var actors = resolveActors_(all);
    // send in chunks of 50
    for (var i = 0; i < all.length; i += 50) send_({ project: CFG.project, source: 'apps-script', actors: actors, activities: all.slice(i, i + 50) });
    // advance cursor by 1 ms past the newest seen (dedupe on the server tolerates overlap anyway)
    PROPS.setProperty('RETRACE_CURSOR', new Date(Date.parse(newest) + 1).toISOString());
    return all.length;
  } finally { lock.releaseLock(); }
}

function send_(payload) {
  var headers = { 'content-type': 'application/json' };
  if (CFG.token) headers.authorization = 'Bearer ' + CFG.token;
  var res = UrlFetchApp.fetch(CFG.url + '/hooks/gdrive?project=' + encodeURIComponent(CFG.project), { method: 'post', headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('Retrace ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
}

/** people/123 → { email, name } via People API; cached 6h. Falls back gracefully if People isn't enabled. */
function resolveActors_(activities) {
  var cache = CacheService.getScriptCache(), out = {}, names = {};
  activities.forEach(function (a) { (a.actors || []).forEach(function (x) { var u = x.user || (x.impersonation && x.impersonation.impersonatedUser); var pn = u && u.knownUser && u.knownUser.personName; if (pn) names[pn] = true; }); });
  Object.keys(names).forEach(function (pn) {
    var hit = cache.get('actor:' + pn);
    if (hit) { out[pn] = JSON.parse(hit); return; }
    try {
      var p = People.People.get(pn, { personFields: 'emailAddresses,names' });
      var info = { email: p.emailAddresses && p.emailAddresses[0] && p.emailAddresses[0].value, name: p.names && p.names[0] && p.names[0].displayName };
      out[pn] = info; cache.put('actor:' + pn, JSON.stringify(info), 21600);
    } catch (e) { out[pn] = {}; }
  });
  // the current user is always resolvable
  var me = Session.getActiveUser().getEmail();
  activities.forEach(function (a) { (a.actors || []).forEach(function (x) { var u = x.user; var k = u && u.knownUser; if (k && k.isCurrentUser && k.personName && !out[k.personName].email) out[k.personName] = { email: me }; }); });
  return out;
}

/** Manual test: forwards the last 24h without touching the cursor. */
function testOnce() {
  var saved = PROPS.getProperty('RETRACE_CURSOR');
  PROPS.setProperty('RETRACE_CURSOR', new Date(Date.now() - 86400000).toISOString());
  var n = poll();
  if (saved) PROPS.setProperty('RETRACE_CURSOR', saved);
  Logger.log('forwarded ' + n + ' activities');
}
