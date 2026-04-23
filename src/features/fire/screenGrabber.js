// src/features/fire/screenGrabber.js
const path = require('path');
const realFs = require('fs');
const os = require('os');

class ScreenGrabber {
    constructor({ capturer, fs = realFs, tmpDir } = {}) {
        this.capturer = capturer; // electron's desktopCapturer
        this.fs = fs;
        this.tmpDir = tmpDir || path.join(os.tmpdir(), 'claudely');
    }

    async grab() {
        this.fs.mkdirSync(this.tmpDir, { recursive: true });
        const sources = await this.capturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
        if (!sources[0]) throw new Error('no screen source');
        const png = sources[0].thumbnail.toPNG();
        const p = path.join(this.tmpDir, `screen-${Date.now()}.png`);
        this.fs.writeFileSync(p, png);
        return p;
    }
}

module.exports = { ScreenGrabber };
