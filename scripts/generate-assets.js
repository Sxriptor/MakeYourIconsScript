#!/usr/bin/env node

const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');
const iconGen = require('icon-gen');
// favicons v7 is ESM; load it compatibly from CommonJS
async function loadFavicons() {
  try {
    const mod = await import('favicons');
    return mod.default || mod;
  } catch (err) {
    try {
      // Fallback if a CJS proxy is available
      // eslint-disable-next-line global-require, import/no-commonjs
      const mod = require('favicons');
      return mod.default || mod;
    } catch (err2) {
      throw err;
    }
  }
}
let potrace;
try {
  potrace = require('potrace');
} catch (e) {
  potrace = null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function ensureBasePng(inputPath, tmpDir, size = 1024) {
  const outPath = path.join(tmpDir, `base-${size}.png`);
  await fs.ensureDir(tmpDir);
  await sharp(inputPath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(outPath);
  return outPath;
}

async function generateElectronIcons(basePngPath, outDir, baseName) {
  await fs.ensureDir(outDir);
  await iconGen(basePngPath, outDir, {
    report: true,
    types: ['ico', 'icns'],
    ico: { name: baseName },
    icns: { name: baseName }
  });
}

async function generateFavicons(basePngPath, outDir, appName) {
  await fs.ensureDir(outDir);
  const source = await fs.readFile(basePngPath);
  const configuration = {
    path: '/',
    appName,
    appShortName: appName,
    appDescription: `${appName} application`,
    developerName: '',
    developerURL: null,
    dir: 'auto',
    lang: 'en-US',
    background: '#ffffff',
    theme_color: '#ffffff',
    display: 'standalone',
    orientation: 'any',
    scope: '/',
    start_url: '/',
    version: '1.0',
    pixel_art: false,
    loadManifestWithCredentials: false,
    icons: {
      android: true,
      appleIcon: true,
      appleStartup: false,
      coast: false,
      favicons: true,
      windows: true,
      yandex: false
    }
  };

  const faviconsFn = await loadFavicons();
  const response = await faviconsFn(source, configuration);
  for (const img of response.images) {
    await fs.writeFile(path.join(outDir, img.name), img.contents);
  }
  for (const file of response.files) {
    await fs.writeFile(path.join(outDir, file.name), file.contents);
  }
  const htmlSnippet = response.html.join('\n');
  await fs.writeFile(path.join(outDir, 'favicons.html'), htmlSnippet, 'utf8');
}

async function generateTracedSvg(inputPath, outDir, baseName) {
  await fs.ensureDir(outDir);
  if (!potrace) {
    console.warn('potrace module not available; skipping SVG tracing');
    return null;
  }
  const tracer = new potrace.Potrace({
    threshold: 180,
    turdSize: 50,
    optTolerance: 0.4,
    color: '#000000',
    background: '#00000000'
  });
  const svgPath = path.join(outDir, `${baseName}.svg`);
  await new Promise((resolve, reject) => {
    tracer.loadImage(inputPath, (err) => {
      if (err) return reject(err);
      tracer.getSVG((err2, svg) => {
        if (err2) return reject(err2);
        fs.writeFile(svgPath, svg, 'utf8').then(resolve).catch(reject);
      });
    });
  });
  return svgPath;
}

async function main() {
  const args = parseArgs(process.argv);
  const input = path.resolve(process.cwd(), args.input || args.i || 'whispra.png');
  const appName = args.name || args.n || path.parse(input).name;
  const outBase = path.resolve(process.cwd(), args.out || args.o || 'dist');

  if (!(await fs.pathExists(input))) {
    console.error(`Input image not found: ${input}`);
    process.exit(1);
  }

  const tmpDir = path.join(outBase, '.tmp');
  const electronOut = path.join(outBase, 'electron');
  const webOut = path.join(outBase, 'web');
  const svgOut = path.join(outBase, 'vector');

  try {
    await fs.ensureDir(outBase);
    const basePngPath = await ensureBasePng(input, tmpDir, 1024);

    console.log('Generating Electron icons (.ico, .icns)...');
    await generateElectronIcons(basePngPath, electronOut, appName);
    console.log('Electron icons done →', electronOut);

    console.log('Generating website favicons...');
    await generateFavicons(basePngPath, webOut, appName);
    console.log('Favicons done →', webOut);

    // Export common PNG sizes early so tracing issues don't block outputs
    const rasterOut = path.join(outBase, 'png');
    await fs.ensureDir(rasterOut);
    const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
    await Promise.all(
      sizes.map((size) =>
        sharp(input)
          .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toFile(path.join(rasterOut, `${appName}-${size}.png`))
      )
    );
    console.log('Exported common PNG sizes →', rasterOut);

    // Trace to SVG with a timeout to avoid hangs on some Windows setups
    console.log('Tracing SVG from source...');
    const withTimeout = (p, ms) =>
      Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Trace timeout')), ms))
      ]);
    try {
      const svgPath = await withTimeout(generateTracedSvg(input, svgOut, appName), 15000);
      if (svgPath) {
        console.log('SVG traced →', svgPath);
      } else {
        console.log('SVG tracing skipped.');
      }
    } catch (traceErr) {
      console.warn('SVG tracing failed or timed out; continuing without vector:', traceErr.message);
    }

    // Cleanup temp
    await fs.remove(tmpDir);
    console.log('All done. Output in:', outBase);
  } catch (err) {
    console.error('Generation failed:', err);
    process.exit(1);
  }
}

main();


