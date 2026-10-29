#!/usr/bin/env node
'use strict';

/**
 * Muse AI Gateway API - Production Release Builder
 *
 * Automates the release build process:
 * 1. Pre-flight verification (syntax check on all source files)
 * 2. Staging clean production files (excluding dev files, local .env secrets, and node_modules)
 * 3. Generating deployment scripts (deploy.sh, start.sh, RELEASE.md)
 * 4. Generating release manifest and SHA-256 checksums
 * 5. Compressing into deployment-ready zip packages (dist/muse-api-server-release.zip)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'package');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Format bytes helper
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Compute SHA-256 of file
function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// Recursive directory copy with ignore filter
function copyDirSync(src, dest, ignoreNames = new Set()) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignoreNames.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, ignoreNames);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Count files and total size
function getDirStats(dir) {
  let count = 0;
  let totalBytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = getDirStats(full);
      count += sub.count;
      totalBytes += sub.totalBytes;
    } else {
      count += 1;
      totalBytes += fs.statSync(full).size;
    }
  }
  return { count, totalBytes };
}

// Create ZIP archive cross-platform
function createZipArchive(sourceDir, zipPath) {
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  if (process.platform === 'win32') {
    const psScript = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}')
    `;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    if (res.status !== 0) {
      throw new Error(`PowerShell ZipFile failed: ${res.stderr || res.stdout}`);
    }
  } else {
    // Linux / macOS: use zip CLI
    const res = spawnSync('zip', ['-rq', zipPath, '.'], {
      cwd: sourceDir,
      encoding: 'utf8'
    });
    if (res.status !== 0) {
      throw new Error(`zip command failed: ${res.stderr || res.stdout}`);
    }
  }
}

async function build() {
  const startTime = Date.now();
  console.log(`\n======================================================`);
  console.log(`  🚀 Building Release: ${pkg.name} v${pkg.version}`);
  console.log(`======================================================\n`);

  // Step 1: Pre-flight syntax validation
  console.log(`[1/5] 🔍 Running pre-flight syntax checks...`);
  const syntaxCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.js')], {
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (syntaxCheck.status !== 0) {
    console.error(`\n❌ Release build aborted: Syntax verification failed.`);
    process.exit(1);
  }
  console.log(`   ✓ Syntax check passed cleanly.\n`);

  // Step 2: Clean and prepare staging directory
  console.log(`[2/5] 🧹 Preparing clean staging environment...`);
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  console.log(`   ✓ Target directory initialized: ${path.relative(ROOT, STAGING_DIR)}\n`);

  // Step 3: Copy production directories and files
  console.log(`[3/5] 📦 Staging production artifacts...`);
  const dirsToCopy = ['src', 'public', 'scripts', 'docs', 'tests'];
  for (const d of dirsToCopy) {
    const srcPath = path.join(ROOT, d);
    if (fs.existsSync(srcPath)) {
      copyDirSync(srcPath, path.join(STAGING_DIR, d), new Set(['.git', '.DS_Store', 'Thumbs.db', 'dist']));
      console.log(`   • Copied ${d}/`);
    }
  }

  // Ensure empty storage structure
  fs.mkdirSync(path.join(STAGING_DIR, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(STAGING_DIR, 'storage', '.gitkeep'), '', 'utf8');

  // Root release files
  const rootFiles = [
    'package.json',
    'package-lock.json',
    'ecosystem.config.js',
    'Dockerfile',
    'docker-compose.yml',
    '.dockerignore',
    '.gitignore',
    '.env.example',
    'README.md'
  ];

  for (const f of rootFiles) {
    const srcPath = path.join(ROOT, f);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(STAGING_DIR, f));
      console.log(`   • Copied ${f}`);
    }
  }

  // Generate automated deployment script for Linux/VPS: deploy.sh
  const deployScript = `#!/usr/bin/env bash
# ==============================================================================
# Muse AI Gateway API - One-Click Production Deployment Script
# ==============================================================================
set -euo pipefail

echo "========================================================"
echo "  🚀 Deploying Muse AI Gateway API v${pkg.version}"
echo "========================================================"

# Check Node.js runtime
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed. Please install Node.js >= 20.12.0"
    exit 1
fi

NODE_VERSION=$(node -v)
echo "✓ Node.js detected: \${NODE_VERSION}"

# 1. Install production dependencies
echo ""
echo "[1/4] Installing production dependencies (npm ci --omit=dev)..."
npm ci --omit=dev --no-audit --no-fund

# 2. Setup storage directory
echo ""
echo "[2/4] Initializing storage directories..."
mkdir -p storage/reference storage/output storage/tmp
chmod -R 755 storage

# 3. Check environment configuration
echo ""
echo "[3/4] Checking .env configuration..."
if [ ! -f .env ]; then
    echo "⚠️  No .env file found. Creating from .env.example..."
    cp .env.example .env
    echo "⚠️  IMPORTANT: Please edit .env with your MONGODB_URI, ADMIN_API_KEY, and SIGNING_SECRET before starting!"
fi

# 4. Service orchestration
echo ""
echo "[4/4] Starting service..."
if command -v pm2 &> /dev/null; then
    pm2 start ecosystem.config.js
    pm2 save
    echo "✓ Process registered with PM2! Check status with 'pm2 status' or 'pm2 logs muse-api'"
else
    echo "PM2 not found. Starting with standard Node.js in background..."
    nohup npm start > api-server.log 2>&1 &
    echo "✓ Started in background with PID $!. Logs are streaming to api-server.log"
fi

echo ""
echo "========================================================"
echo "  🎉 Deployment completed successfully!"
echo "========================================================"
`;
  fs.writeFileSync(path.join(STAGING_DIR, 'deploy.sh'), deployScript.replace(/\r\n/g, '\n'), {
    mode: 0o755,
    encoding: 'utf8'
  });
  console.log(`   • Generated deploy.sh (Linux/VPS deployment script)`);

  // Generate RELEASE.md
  const buildDate = new Date().toISOString();
  const releaseDoc = `# Muse AI Gateway API - Release Package v${pkg.version}

- **Build Date**: ${buildDate}
- **Engine**: Node.js ${pkg.engines.node}
- **Architecture**: Modular REST + WebSocket + Noise Protocol Engine

## 🚀 Quick Deployment Guide

### Option 1: PM2 on VPS (Recommended)

\`\`\`bash
# 1. Extract package on server
unzip muse-api-server-release.zip -d /www/wwwroot/muse-api
cd /www/wwwroot/muse-api

# 2. Run one-click deploy script
chmod +x deploy.sh
./deploy.sh

# Or manually:
npm ci --omit=dev
cp .env.example .env && nano .env
pm2 start ecosystem.config.js
pm2 save && pm2 startup
\`\`\`

### Option 2: Docker / Docker Compose

\`\`\`bash
# Configure .env
cp .env.example .env
nano .env

# Run with docker compose
docker compose up -d --build
docker compose logs -f api
\`\`\`

### Option 3: Direct Node.js

\`\`\`bash
npm ci --omit=dev
cp .env.example .env
npm start
\`\`\`
`;
  fs.writeFileSync(path.join(STAGING_DIR, 'RELEASE.md'), releaseDoc, 'utf8');
  console.log(`   • Generated RELEASE.md`);

  // Step 4: Manifest & Statistics
  console.log(`\n[4/5] 📋 Generating release manifest & hashes...`);
  const stats = getDirStats(STAGING_DIR);
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    buildTime: buildDate,
    nodeEngine: pkg.engines.node,
    fileCount: stats.count,
    totalSizeBytes: stats.totalBytes,
    totalSizeFormatted: formatBytes(stats.totalBytes),
    coreHashes: {
      'src/server.js': computeSha256(path.join(STAGING_DIR, 'src', 'server.js')),
      'src/app.js': computeSha256(path.join(STAGING_DIR, 'src', 'app.js')),
      'src/config.js': computeSha256(path.join(STAGING_DIR, 'src', 'config.js')),
      'package.json': computeSha256(path.join(STAGING_DIR, 'package.json'))
    }
  };
  fs.writeFileSync(path.join(STAGING_DIR, 'release-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(DIST_DIR, 'release-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`   ✓ Packaged ${stats.count} files (${formatBytes(stats.totalBytes)})`);

  // Step 5: Packaging ZIP archives
  console.log(`\n[5/5] 🗜️  Compressing release archive...`);
  const zipName = `muse-api-server-release.zip`;
  const versionedZipName = `muse-api-server-v${pkg.version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);
  const versionedZipPath = path.join(DIST_DIR, versionedZipName);

  createZipArchive(STAGING_DIR, zipPath);
  fs.copyFileSync(zipPath, versionedZipPath);

  // Also copy to root workspace for instant access
  const workspaceZipPath = path.resolve(ROOT, '..', 'muse-api-server-release.zip');
  fs.copyFileSync(zipPath, workspaceZipPath);

  const zipStats = fs.statSync(zipPath);
  const zipSha256 = computeSha256(zipPath);
  fs.writeFileSync(`${zipPath}.sha256`, `${zipSha256} *${zipName}\n`, 'utf8');
  fs.writeFileSync(`${versionedZipPath}.sha256`, `${zipSha256} *${versionedZipName}\n`, 'utf8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n======================================================`);
  console.log(`  ✨ RELEASE BUILD SUCCESSFUL (${elapsed}s)`);
  console.log(`======================================================`);
  console.log(`• Release Version : v${pkg.version}`);
  console.log(`• Staged Files    : ${stats.count} files (${formatBytes(stats.totalBytes)})`);
  console.log(`• Release ZIP     : ${path.relative(ROOT, zipPath)} (${formatBytes(zipStats.size)})`);
  console.log(`• Versioned ZIP   : ${path.relative(ROOT, versionedZipPath)}`);
  console.log(`• Workspace ZIP   : ${path.relative(path.resolve(ROOT, '..'), workspaceZipPath)}`);
  console.log(`• SHA-256 Checksum: ${zipSha256}`);
  console.log(`======================================================\n`);
}

build().catch((err) => {
  console.error(`\n❌ Build failed with error:`, err);
  process.exit(1);
});
