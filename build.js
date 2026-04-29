const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const baseConfig = {
    bundle: true,
    platform: 'browser',
    format: 'esm',
    loader: { '.js': 'jsx' },
    sourcemap: true,
    external: ['electron'],
    define: {
        'process.env.NODE_ENV': `"${process.env.NODE_ENV || 'development'}"`,
    },
};

const entryPoints = [
    { in: 'src/ui/app/HeaderController.js', out: 'public/build/header' },
    { in: 'src/ui/app/PickleGlassApp.js', out: 'public/build/content' },
];

const nativeBinaries = [
    {
        name: 'audio-capture',
        src: path.join(__dirname, 'native/audio-capture/.build/release/audio-capture'),
        dst: path.join(__dirname, 'src/ui/assets/bin/audio-capture'),
        buildHint: 'npm run build:native',
    },
    {
        name: 'classifier',
        src: path.join(__dirname, 'native/classifier/.build/release/classifier'),
        dst: path.join(__dirname, 'src/ui/assets/bin/classifier'),
        buildHint: 'npm run build:native',
    },
    {
        name: 'calendar-now',
        src: path.join(__dirname, 'native/calendar-now/.build/release/calendar-now'),
        dst: path.join(__dirname, 'src/ui/assets/bin/calendar-now'),
        buildHint: 'npm run build:native',
    },
];

function copyNativeBinaries({ strict = false } = {}) {
    for (const bin of nativeBinaries) {
        if (!fs.existsSync(bin.src)) {
            const msg = `Missing native binary ${bin.name}. Run: ${bin.buildHint}`;
            if (strict) { console.error(msg); process.exit(1); }
            console.warn(`⚠️  ${msg}`);
            continue;
        }
        fs.mkdirSync(path.dirname(bin.dst), { recursive: true });
        fs.copyFileSync(bin.src, bin.dst);
        fs.chmodSync(bin.dst, 0o755);
        console.log(`✅ Copied native ${bin.name} → ${bin.dst}`);
    }
}

async function build() {
    try {
        console.log('Building renderer process code...');
        await Promise.all(entryPoints.map(point => esbuild.build({
            ...baseConfig,
            entryPoints: [point.in],
            outfile: `${point.out}.js`,
        })));
        console.log('✅ Renderer builds successful!');

        if (!process.argv.includes('--skip-native')) {
            try { copyNativeBinaries(); } catch (e) { console.warn('Native copy failed:', e.message); }
        }
    } catch (e) {
        console.error('Renderer build failed:', e);
        process.exit(1);
    }
}

async function watch() {
    try {
        const contexts = await Promise.all(entryPoints.map(point => esbuild.context({
            ...baseConfig,
            entryPoints: [point.in],
            outfile: `${point.out}.js`,
        })));

        console.log('Watching for changes...');
        await Promise.all(contexts.map(context => context.watch()));

    } catch (e) {
        console.error('Watch mode failed:', e);
        process.exit(1);
    }
}

if (process.argv.includes('--watch')) {
    watch();
} else {
    build();
}
