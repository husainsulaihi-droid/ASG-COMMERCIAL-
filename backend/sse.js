/**
 * Server-Sent Events for real-time dashboard sync.
 *
 * Each authenticated browser opens a long-lived GET /api/events stream.
 * Whenever any client mutates an entity (POST/PATCH/DELETE), the
 * broadcast-middleware fires a small JSON event to every connected
 * stream, telling the frontend which entity changed. The frontend
 * refetches that cache + re-renders the active tab.
 *
 * Event payload shape:
 *   { entity: 'properties', method: 'PATCH', path: '/api/properties/12', ts: 1234 }
 *
 * Heartbeat: every 25s a comment-only ": ping\n\n" keeps nginx + the
 * browser from closing the connection on idle.
 */

const clients = new Set();

function addClient(req, res) {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx buffering for this response
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch (_) { cleanup(); }
  }, 25000);

  function cleanup() {
    clearInterval(heartbeat);
    clients.delete(res);
  }

  req.on('close', cleanup);
  req.on('error', cleanup);

  clients.add(res);
  console.log(`[sse] client connected (total=${clients.size})`);
}

function broadcast(payload) {
  if (!clients.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); }
    catch (_) { clients.delete(res); }
  }
}

function clientCount() { return clients.size; }

module.exports = { addClient, broadcast, clientCount };
