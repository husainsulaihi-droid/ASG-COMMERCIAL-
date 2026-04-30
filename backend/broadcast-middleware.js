/**
 * Broadcast middleware. After any successful mutation on a known entity
 * route, fire a small SSE event so all connected dashboards refetch
 * that entity. Mounted globally before the route handlers.
 *
 * Limitations:
 *   - Only fires on 2xx responses (failures don't notify).
 *   - The entity is derived from the URL prefix; routes outside this
 *     map won't broadcast.
 */

const { broadcast } = require('./sse');

const ENTITY_MAP = [
  ['/api/properties',          'properties'],
  ['/api/leads',               'leads'],
  ['/api/tasks',               'tasks'],
  ['/api/meetings',            'meetings'],
  ['/api/announcements',       'announcements'],
  ['/api/leaves',              'leaves'],
  ['/api/proposals',           'proposals'],
  ['/api/pending-properties',  'pending'],
  ['/api/disputes',            'disputes'],
  ['/api/construction',        'construction'],
  ['/api/calendar',            'calendar'],
  ['/api/secondary',           'secondary'],
  ['/api/offplan/developers',  'offplanDevs'],
  ['/api/offplan/projects',    'offplanProjects'],
  ['/api/users',               'users'],
];

const MUTATIONS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Property files (uploads) are nested under /api/properties/:id/files —
// matched separately so we broadcast as 'propertyFiles' instead of 'properties'.
function entityForPath(path) {
  if (/^\/api\/properties\/\d+\/files/.test(path)) return 'propertyFiles';
  if (/^\/api\/properties\/\d+\/cheques/.test(path)) return 'cheques';
  for (const [prefix, name] of ENTITY_MAP) {
    if (path === prefix || path.startsWith(prefix + '/')) return name;
  }
  return null;
}

function broadcastMiddleware(req, res, next) {
  if (!MUTATIONS.has(req.method)) return next();
  // Express strips the mount prefix from req.path when middleware is
  // mounted with app.use('/api', ...). Use originalUrl so our prefix
  // map (which includes /api/) still matches.
  const fullPath = (req.originalUrl || req.url).split('?')[0];
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const entity = entityForPath(fullPath);
    if (!entity) return;
    broadcast({
      entity,
      method: req.method,
      path:   fullPath,
      ts:     Date.now(),
    });
  });
  next();
}

module.exports = broadcastMiddleware;
