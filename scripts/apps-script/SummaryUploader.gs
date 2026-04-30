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
// After that every Claudely listen session ends with a Google Doc landing in
// "<PARENT_FOLDER_NAME>/<TARGET_FOLDER_NAME>" automatically.

const SHARED_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const PARENT_FOLDER_NAME = 'Claudely Transcripts';
const TARGET_FOLDER_NAME = 'Meeting Summary';

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

        const folder = ensureTargetFolder();
        const blob = Utilities.newBlob(body.html, 'text/html', body.title + '.html');
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

        return jsonOut({
            ok: true,
            id: file.id,
            url: 'https://docs.google.com/document/d/' + file.id + '/edit',
            folder: folder.getName(),
        });
    } catch (err) {
        return jsonOut({ ok: false, error: String(err && err.stack || err) });
    }
}

// GET handler for a quick health check from a browser. Returns JSON, never
// echoes the secret.
function doGet() {
    return jsonOut({ ok: true, hint: 'POST {secret, title, html} to upload' });
}

function ensureTargetFolder() {
    const parents = DriveApp.getFoldersByName(PARENT_FOLDER_NAME);
    if (!parents.hasNext()) {
        // Auto-create the parent at Drive root if missing — first-run friendly.
        const root = DriveApp.getRootFolder();
        return root.createFolder(PARENT_FOLDER_NAME).createFolder(TARGET_FOLDER_NAME);
    }
    const parent = parents.next();
    const subs = parent.getFoldersByName(TARGET_FOLDER_NAME);
    if (subs.hasNext()) return subs.next();
    return parent.createFolder(TARGET_FOLDER_NAME);
}

function jsonOut(obj) {
    return ContentService
        .createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}
