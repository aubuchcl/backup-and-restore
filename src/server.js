import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {
  config,
  createBackup,
  listBackups,
  manifestPath,
  removeBackup,
  safeArchivePath,
} from './backup.js';

const token = process.env.BACKUP_TOKEN || '';
const allowNoToken = process.env.ALLOW_NO_TOKEN === 'true';

if (!token && !allowNoToken) {
  console.error('BACKUP_TOKEN is not set. Set it, or set ALLOW_NO_TOKEN=true to run unauthenticated.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

/** Liveness. Left unauthenticated so orchestrator health checks work. */
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * Shared-secret auth. This service is meant to sit on a private network, but a
 * token costs nothing and means an accidentally published port is not an
 * immediate database leak.
 */
app.use((req, res, next) => {
  if (!token) {
    next();
    return;
  }

  const header = req.get('authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '');

  // Constant-time compare, and equal-length buffers, so a mismatched length
  // cannot be distinguished by timing.
  const a = Buffer.from(supplied.padEnd(64).slice(0, 64));
  const b = Buffer.from(token.padEnd(64).slice(0, 64));

  if (!supplied || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Provide a valid bearer token.' });
    return;
  }

  next();
});

app.post('/backups', async (req, res) => {
  try {
    const manifest = await createBackup();
    res.status(201).json(manifest);
  } catch (err) {
    const conflict = /already in progress/.test(err.message);
    res.status(conflict ? 409 : 500).json({ error: err.message });
  }
});

app.get('/backups', async (req, res) => {
  try {
    const manifests = await listBackups();
    res.json({ count: manifests.length, backups: manifests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/backups/latest', async (req, res) => {
  try {
    const manifests = await listBackups();

    if (manifests.length === 0) {
      res.status(404).json({ error: 'No backups yet. POST /backups to make one.' });
      return;
    }

    res.json(manifests[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/backups/:id/manifest', async (req, res) => {
  const archive = safeArchivePath(req.params.id);

  if (!archive) {
    res.status(400).json({ error: 'Malformed backup id.' });
    return;
  }

  try {
    const raw = await fsp.readFile(manifestPath(req.params.id), 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).json({ error: 'No such backup.' });
  }
});

/** Streams the archive. This is what the restore side pulls. */
app.get('/backups/:id', async (req, res) => {
  const archive = safeArchivePath(req.params.id);

  if (!archive) {
    res.status(400).json({ error: 'Malformed backup id.' });
    return;
  }

  if (!fs.existsSync(archive)) {
    res.status(404).json({ error: 'No such backup.' });
    return;
  }

  let manifest = null;

  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath(req.params.id), 'utf8'));
  } catch {
    manifest = null;
  }

  const stat = await fsp.stat(archive);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.archive.gz"`);

  // The consumer verifies this before restoring.
  if (manifest?.sha256) {
    res.setHeader('X-Checksum-Sha256', manifest.sha256);
    res.setHeader('ETag', `"${manifest.sha256}"`);
  }

  const stream = fs.createReadStream(archive);

  stream.on('error', () => {
    res.destroy();
  });

  stream.pipe(res);
});

app.delete('/backups/:id', async (req, res) => {
  const removed = await removeBackup(req.params.id);

  if (!removed) {
    res.status(400).json({ error: 'Malformed backup id.' });
    return;
  }

  res.status(204).end();
});

const port = Number(process.env.PORT || 4000);
const host = process.env.BIND_HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.log(`backup-relay listening on ${host}:${port}`);
  console.log(`  store        ${config.dir}`);
  console.log(`  keep         ${config.keep}`);
  console.log(`  source set   ${config.uri ? 'yes' : 'no — set MONGODB_URI'}`);
  console.log(`  auth         ${token ? 'bearer token required' : 'DISABLED'}`);
});
