import crypto from 'node:crypto';
import logger from '../logger.js';

/**
 * In-memory, short-TTL store for retrieved policy documents.
 *
 * Deliberately never written to disk. These are somebody's actual insurance
 * declarations: full name, home address, VIN, coverage limits, premium. Holding
 * them in RAM with a hard TTL means a stolen disk image or a forgotten volume
 * cannot leak them, and there is no cleanup job to get wrong.
 *
 * The documents are served over HTTP rather than pushed down the WebSocket,
 * because handing the browser a real `application/pdf` response lets its native
 * viewer render it in an iframe. Base64-ing multi-hundred-KB PDFs through the
 * socket and reassembling them in JS would be slower and worse.
 */

const log = logger.child({ module: 'documentStore' });
const TTL_MS = 10 * 60_000;

/** sessionId -> Map<docId, {name, mime, bytes, ...}> */
const bySession = new Map();

const timer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, docs] of bySession) {
    for (const [docId, doc] of docs) {
      if (now - doc.storedAt > TTL_MS) docs.delete(docId);
    }
    if (docs.size === 0) bySession.delete(sessionId);
  }
}, 60_000);
timer.unref();

/**
 * Store documents for a session.
 * @returns metadata only, safe to send to the client.
 */
export function putDocuments(sessionId, documents) {
  const docs = bySession.get(sessionId) ?? new Map();
  const meta = [];

  for (const doc of documents) {
    const docId = crypto.randomBytes(8).toString('hex');
    docs.set(docId, { ...doc, storedAt: Date.now() });
    meta.push({
      docId,
      name: doc.name,
      label: doc.label ?? doc.name,
      kind: doc.kind ?? 'document',
      mime: doc.mime ?? 'application/pdf',
      bytes: doc.bytes.length,
      url: `/api/sessions/${sessionId}/documents/${docId}`,
    });
  }

  bySession.set(sessionId, docs);
  log.info({ sessionId, count: meta.length }, 'documents stored');
  return meta;
}

export function getDocument(sessionId, docId) {
  return bySession.get(sessionId)?.get(docId) ?? null;
}

export function dropSession(sessionId) {
  bySession.delete(sessionId);
}

export function stats() {
  let docs = 0;
  let bytes = 0;
  for (const m of bySession.values()) {
    for (const d of m.values()) {
      docs += 1;
      bytes += d.bytes.length;
    }
  }
  return { sessions: bySession.size, documents: docs, bytes };
}

export default { putDocuments, getDocument, dropSession, stats };
