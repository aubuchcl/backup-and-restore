import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";

export const config = {
  uri: process.env.MONGODB_URI || "",
  dbName: process.env.MONGODB_DB || "",
  caFile: process.env.MONGODB_TLS_CA_FILE || "",
  readPreference: process.env.MONGODB_READ_PREFERENCE || "",
  dir: process.env.BACKUP_DIR || "/data/backups",
  keep: Number(process.env.BACKUP_KEEP || 5),
  mongodumpBin: process.env.MONGODUMP_BIN || "mongodump",
  timeoutMs: Number(process.env.BACKUP_TIMEOUT_MS || 600000),
};

// Timestamp plus random suffix. Sortable, and safe as a filename component.
export const ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;

let running = false;

function newId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}

export function archivePath(id) {
  return path.join(config.dir, `${id}.archive.gz`);
}

export function manifestPath(id) {
  return path.join(config.dir, `${id}.json`);
}

export function safeArchivePath(id) {
  if (!ID_PATTERN.test(id)) {
    return null;
  }

  const resolved = path.resolve(archivePath(id));
  const root = path.resolve(config.dir) + path.sep;

  if (!resolved.startsWith(root)) {
    return null;
  }

  return resolved;
}

/**
 * TLS goes in the connection string rather than on the command line. The tools
 * have shifted between --ssl/--sslCAFile and --tls/--tlsCAFile across versions,
 * but the URI options are stable.
 */
function dumpUri() {
  let uri = config.uri;

  if (config.caFile && !/[?&]tls(CAFile)?=/i.test(uri)) {
    const joiner = uri.includes("?") ? "&" : "?";
    uri = `${uri}${joiner}tls=true&tlsCAFile=${encodeURIComponent(config.caFile)}`;
  }

  if (config.readPreference && !/[?&]readPreference=/i.test(uri)) {
    const joiner = uri.includes("?") ? "&" : "?";
    uri = `${uri}${joiner}readPreference=${encodeURIComponent(config.readPreference)}`;
  }

  return uri;
}

async function collectionCounts() {
  const options = { serverSelectionTimeoutMS: 10000, retryWrites: false };

  if (config.caFile) {
    options.tls = true;
    options.tlsCAFile = config.caFile;
  }

  if (process.env.MONGODB_DIRECT_CONNECTION === "true") {
    options.directConnection = true;
  }

  const client = await MongoClient.connect(config.uri, options);

  try {
    const db = client.db(config.dbName || undefined);
    const entries = await db.listCollections().toArray();
    const counts = {};

    for (const entry of entries) {
      counts[entry.name] = await db.collection(entry.name).countDocuments();
    }

    const buildInfo = await db
      .admin()
      .command({ buildInfo: 1 })
      .catch(() => null);

    return {
      counts,
      database: db.databaseName,
      serverVersion: buildInfo?.version || "unknown",
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function runMongodump(target) {
  return new Promise((resolve, reject) => {
    const args = [`--uri=${dumpUri()}`, `--archive=${target}`, "--gzip"];

    if (config.dbName) {
      args.push(`--db=${config.dbName}`);
    }

    const child = spawn(config.mongodumpBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`mongodump exceeded ${config.timeoutMs} ms`));
    }, config.timeoutMs);

    // mongodump writes its progress log to stderr even on success.
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (err.code === "ENOENT") {
        reject(
          new Error(
            `mongodump not found at "${config.mongodumpBin}" — is mongodb-database-tools installed in this image?`,
          ),
        );
        return;
      }

      reject(err);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve(stderr.trim());
        return;
      }

      // Surface the tail of mongodump's own log; it names the real problem.
      const tail = stderr.trim().split("\n").slice(-4).join(" | ");
      reject(new Error(`mongodump exited ${code}: ${tail}`));
    });
  });
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function createBackup() {
  if (!config.uri) {
    throw new Error("MONGODB_URI is not set.");
  }

  if (running) {
    throw new Error("A backup is already in progress.");
  }

  running = true;
  const id = newId();
  const target = archivePath(id);
  const startedAt = Date.now();

  try {
    await fsp.mkdir(config.dir, { recursive: true });

    // Counts come from the source before the dump, so the manifest records what
    // the restore side should expect to find.
    const source = await collectionCounts();
    const log = await runMongodump(target);
    const stat = await fsp.stat(target);
    const sha256 = await sha256Of(target);

    const manifest = {
      id,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      database: source.database,
      serverVersion: source.serverVersion,
      collections: source.counts,
      totalDocuments: Object.values(source.counts).reduce(
        (sum, n) => sum + n,
        0,
      ),
      sizeBytes: stat.size,
      sha256,
      format: "mongodump --archive --gzip",
      restoreHint:
        "mongorestore --archive=<file> --gzip --nsFrom / --nsTo as needed",
      toolLog: log.split("\n").slice(-3).join("\n"),
    };

    await fsp.writeFile(
      manifestPath(id),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await prune();

    return manifest;
  } catch (err) {
    // Never leave a truncated archive behind for a consumer to fetch.
    await fsp.rm(target, { force: true }).catch(() => {});
    await fsp.rm(manifestPath(id), { force: true }).catch(() => {});
    throw err;
  } finally {
    running = false;
  }
}

export async function listBackups() {
  await fsp.mkdir(config.dir, { recursive: true });
  const files = await fsp.readdir(config.dir);
  const manifests = [];

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }

    try {
      const raw = await fsp.readFile(path.join(config.dir, file), "utf8");
      const manifest = JSON.parse(raw);

      // Only advertise a backup whose archive is actually still on disk.
      if (fs.existsSync(archivePath(manifest.id))) {
        manifests.push(manifest);
      }
    } catch {
      continue;
    }
  }

  manifests.sort((a, b) => (a.id < b.id ? 1 : -1));
  return manifests;
}

export async function prune() {
  if (!Number.isFinite(config.keep) || config.keep <= 0) {
    return [];
  }

  const manifests = await listBackups();
  const stale = manifests.slice(config.keep);

  for (const manifest of stale) {
    await fsp.rm(archivePath(manifest.id), { force: true }).catch(() => {});
    await fsp.rm(manifestPath(manifest.id), { force: true }).catch(() => {});
  }

  return stale.map((manifest) => manifest.id);
}

export async function removeBackup(id) {
  if (!ID_PATTERN.test(id)) {
    return false;
  }

  const archive = safeArchivePath(id);

  if (!archive) {
    return false;
  }

  await fsp.rm(archive, { force: true });
  await fsp.rm(manifestPath(id), { force: true });
  return true;
}
