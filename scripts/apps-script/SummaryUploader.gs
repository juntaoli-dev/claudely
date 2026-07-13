// Claudely → Google Drive summary uploader (Apps Script Web App).
//
// One-time setup:
//   1. Go to https://script.google.com → New project (rename to "Claudely Summary Uploader").
//   2. Paste the contents of THIS file into Code.gs (replace the default helloWorld).
//   3. Click the gear icon "Project Settings" → check "Show appsscript.json" if needed.
//   4. Click "Services" (left sidebar) → "+ Add a service" → select "Drive API"
//      (identifier: Drive, version v2) → "Add". This enables the advanced service
//      we need for the convert: true upload.
//   5. Replace SHARED_SECRET below with a long random string (e.g. `openssl rand -hex 24`).
//      Paste the SAME value into ~/.claudely/config.json under "summarySecret".
//   6. Adjust PARENT_FOLDER_NAME / TARGET_FOLDER_NAME if your folder layout differs.
//   7. Click "Deploy" → "New deployment" → gear icon → "Web app" →
//        Description: "Claudely summary uploader v1"
//        Execute as: Me (your email)
//        Who has access: Anyone
//      Click "Deploy" → grant the OAuth permissions when prompted.
//   8. Copy the resulting Web App URL (looks like
//      https://script.google.com/macros/s/AKfy.../exec) and paste it into
//      ~/.claudely/config.json under "summaryWebhookUrl".
//
// Each summary lands at:
//   <PARENT_FOLDER_NAME>/<TARGET_FOLDER_NAME>/<YYYY-MM>/<doc>
// where <YYYY-MM> is the bucket Claudely passes in the POST body. The script
// auto-creates each month subfolder on demand. If no monthBucket is sent, the
// doc lands directly in <TARGET_FOLDER_NAME> as a fallback.

const SHARED_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const PARENT_FOLDER_NAME = 'Claudely Transcripts';
const TARGET_FOLDER_NAME = 'Meeting Summary';
const DOC_KEY_PREFIX = 'summaryDocId:';

function doPost(e) {
    try {
        if (!e || !e.postData || !e.postData.contents) {
            return jsonOut({ ok: false, error: 'no body' });
        }
        const body = JSON.parse(e.postData.contents);
        if (!body.secret || body.secret !== SHARED_SECRET) {
            return jsonOut({ ok: false, error: 'unauthorized' });
        }
        if (!body.title || !body.html) {
            return jsonOut({ ok: false, error: 'missing title or html' });
        }

        const folder = ensureTargetFolder(body.monthBucket);
        const blob = Utilities.newBlob(body.html, 'text/html', body.title + '.html');
        const dedupeKey = normalizeDedupeKey(body.dedupeKey);
        const storedDocId = dedupeKey ? getDocIdForKey(dedupeKey) : '';
        const targetDocId = body.docId || storedDocId;

        // Live re-summary path: when a docId is supplied, replace that Doc's
        // content in place so a meeting stays a single, continuously-updated
        // Doc instead of spawning one per cycle. convert: true re-runs the
        // HTML → Google Doc conversion over the existing file. If the id is
        // stale (trashed / not found), fall back to creating a fresh Doc.
        if (targetDocId) {
            try {
                const updated = Drive.Files.update(
                    { title: body.title },
                    targetDocId,
                    blob,
                    { convert: true }
                );
                if (dedupeKey) setDocIdForKey(dedupeKey, updated.id);
                return jsonOut({
                    ok: true,
                    id: updated.id,
                    url: 'https://docs.google.com/document/d/' + updated.id + '/edit',
                    folder: folder.getName(),
                    updated: true,
                    supportsDedupe: true,
                    dedupeKey: dedupeKey || '',
                });
            } catch (updateErr) {
                if (dedupeKey && storedDocId && targetDocId === storedDocId) clearDocIdForKey(dedupeKey);
                // fall through to insert a new Doc below
            }
        }

        // Drive Advanced Service v2: convert: true triggers server-side HTML
        // → Google Doc conversion. Resulting file's mimeType is
        // application/vnd.google-apps.document (a real Google Doc).
        const file = Drive.Files.insert(
            {
                title: body.title,
                parents: [{ id: folder.getId() }],
                mimeType: 'application/vnd.google-apps.document',
            },
            blob,
            { convert: true }
        );
        if (dedupeKey) setDocIdForKey(dedupeKey, file.id);

        return jsonOut({
            ok: true,
            id: file.id,
            url: 'https://docs.google.com/document/d/' + file.id + '/edit',
            folder: folder.getName(),
            supportsDedupe: true,
            dedupeKey: dedupeKey || '',
        });
    } catch (err) {
        return jsonOut({ ok: false, error: String(err && err.stack || err) });
    }
}

function normalizeDedupeKey(key) {
    key = String(key || '').trim();
    if (!key) return '';
    return key.slice(0, 180);
}

function getDocIdForKey(key) {
    return PropertiesService.getScriptProperties().getProperty(DOC_KEY_PREFIX + key) || '';
}

function setDocIdForKey(key, docId) {
    if (!key || !docId) return;
    PropertiesService.getScriptProperties().setProperty(DOC_KEY_PREFIX + key, docId);
}

function clearDocIdForKey(key) {
    if (!key) return;
    PropertiesService.getScriptProperties().deleteProperty(DOC_KEY_PREFIX + key);
}

// GET handler for a quick health check from a browser. Returns JSON, never
// echoes the secret.
function doGet() {
    return jsonOut({
        ok: true,
        hint: 'POST {secret, title, html} to upload',
        supportsDedupe: true,
        version: 'summary-dedupe-v2',
    });
}

// Resolve <PARENT_FOLDER_NAME>/<TARGET_FOLDER_NAME>[/<YYYY-MM>], creating any
// missing pieces. Returns the deepest folder.
function ensureTargetFolder(monthBucket) {
    const parents = DriveApp.getFoldersByName(PARENT_FOLDER_NAME);
    let parent;
    if (!parents.hasNext()) {
        parent = DriveApp.getRootFolder().createFolder(PARENT_FOLDER_NAME);
    } else {
        parent = parents.next();
    }
    const subs = parent.getFoldersByName(TARGET_FOLDER_NAME);
    let summary = subs.hasNext() ? subs.next() : parent.createFolder(TARGET_FOLDER_NAME);
    if (!monthBucket || !/^\d{4}-\d{2}$/.test(monthBucket)) return summary;
    const monthSubs = summary.getFoldersByName(monthBucket);
    if (monthSubs.hasNext()) return monthSubs.next();
    return summary.createFolder(monthBucket);
}

// One-shot helper: walk every Google Doc currently sitting in
// <Meeting Summary> root and move each into <YYYY-MM>/ derived from the
// doc's createdDate. Run from the Apps Script editor: select reorganize
// from the function dropdown and click Run. Idempotent — re-running does
// nothing once everything's bucketed.
function reorganize() {
    const parents = DriveApp.getFoldersByName(PARENT_FOLDER_NAME);
    if (!parents.hasNext()) { Logger.log('parent folder missing'); return; }
    const subs = parents.next().getFoldersByName(TARGET_FOLDER_NAME);
    if (!subs.hasNext()) { Logger.log('summary folder missing'); return; }
    const summaryFolder = subs.next();
    const docs = summaryFolder.getFilesByType(MimeType.GOOGLE_DOCS);
    let moved = 0;
    while (docs.hasNext()) {
        const f = docs.next();
        const d = f.getDateCreated();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const bucket = yyyy + '-' + mm;
        const monthSubs = summaryFolder.getFoldersByName(bucket);
        const target = monthSubs.hasNext() ? monthSubs.next() : summaryFolder.createFolder(bucket);
        // Drive v2 move: add to new folder, remove from old.
        target.addFile(f);
        summaryFolder.removeFile(f);
        moved++;
        Logger.log('moved %s → %s', f.getName(), bucket);
    }
    Logger.log('reorganize done: moved=%s', moved);
}

function jsonOut(obj) {
    return ContentService
        .createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}
