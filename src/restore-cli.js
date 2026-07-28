import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';

/**
 * Runs on the receiving side. Pulls an archive from the relay, verifies it
 * against the checksum in the manifest, restores it, then re-counts documents
 * and compares against what the manifest said the source held.
 *
 *   RELAY_URL     http://backup-relay:4000
 *   BACKUP_TOKEN  same shared secret the relay uses
 *   TARGET_URI    where to restore to (the new cluster)
 *   BACKUP_ID     optional; defaults to latest
 */

const relayUrl = (process.env.RELAY_URL || '').replace(/\/$/, '');
const token = process.env.BACKUP_TOKEN || '';
const targetUri = process.env.TARGET_URI || '';
const backupId = process.env.BACKUP_ID || '';
const mongorestoreBin = process.env.MONGORESTORE_BIN || 'mongorestore';
const dropFirst = process.env.RESTORE_DROP === 'true';

function authHeaders() {
  if (!token) {
    return {};
  }

  return { authorization: `Bearer ${token}` };
}

async function fetchManifest() {
  const suffix = backupId ? `/backups/${backupId}/manifest` : '/backups/latest';
  const response = await fetch(`${relayUrl}${suffix}`, { headers: authHeaders() });

  if (!response.ok) {
    throw new Error(`Relay returned ${response.status} for the manifest.`);
  }

  return response.json();
}

async function download(manifest, destination) {
  const response = await fetch(`${relayUrl}/backups/${manifest.id}`, { headers: authHeaders() });

  if (!response.ok) {
    throw new Error(`Relay returned ${response.status} for the archive.`);
  }

  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(destination, 'w');

  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  const actual = hash.digest('hex');

  if (manifest.sha256 && actual !== manifest.sha256) {
    throw new Error(`Checksum mismatch. Manifest says ${manifest.sha256}, download is ${actual}. Refusing to restore.`);
  }

  return actual;
}

function runMongorestore(archive) {
  return new Promise((resolve, reject) => {
    const args = [`--uri=${targetUri}`, `--archive=${archive}`, '--gzip'];

    if (dropFirst) {
      args.push('--drop');
    }

    // Indexes are built after the data loads; parallel insert workers make the
    // load itself meaningfully faster.
    args.push('--numInsertionWorkersPerCollection=4');

    const child = spawn(mongorestoreBin, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`mongorestore not found at "${mongorestoreBin}".`));
        return;
      }

      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const tail = stderr.trim().split('\n').slice(-4).join(' | ');
      reject(new Error(`mongorestore exited ${code}: ${tail}`));
    });
  });
}

async function verifyCounts(manifest) {
  const client = await MongoClient.connect(targetUri, { serverSelectionTimeoutMS: 10000 });

  try {
    const db = client.db(manifest.database);
    const mismatches = [];

    for (const [name, expected] of Object.entries(manifest.collections || {})) {
      const actual = await db.collection(name).countDocuments();
      const status = actual === expected ? 'ok' : 'MISMATCH';
      console.log(`  ${name.padEnd(20)} expected ${String(expected).padStart(6)}  got ${String(actual).padStart(6)}  ${status}`);

      if (actual !== expected) {
        mismatches.push(name);
      }
    }

    return mismatches;
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  if (!relayUrl) {
    throw new Error('RELAY_URL is not set.');
  }

  if (!targetUri) {
    throw new Error('TARGET_URI is not set.');
  }

  console.log(`Fetching manifest from ${relayUrl}`);
  const manifest = await fetchManifest();
  console.log(`  backup       ${manifest.id}`);
  console.log(`  taken        ${manifest.createdAt}`);
  console.log(`  database     ${manifest.database}`);
  console.log(`  documents    ${manifest.totalDocuments}`);
  console.log(`  size         ${(manifest.sizeBytes / 1024).toFixed(1)} KiB`);
  console.log('');

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-'));
  const archive = path.join(workDir, `${manifest.id}.archive.gz`);

  try {
    console.log('Downloading and verifying');
    const sha = await download(manifest, archive);
    console.log(`  sha256 ok    ${sha}`);
    console.log('');

    console.log('Restoring');
    await runMongorestore(archive);
    console.log('');

    console.log('Verifying document counts');
    const mismatches = await verifyCounts(manifest);
    console.log('');

    if (mismatches.length > 0) {
      console.error(`Restore finished but ${mismatches.length} collection(s) do not match: ${mismatches.join(', ')}`);
      process.exit(1);
    }

    console.log('Restore complete. Every collection matches the source counts.');
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exit(1);
});
