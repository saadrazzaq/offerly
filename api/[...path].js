// Vercel catch-all for /api/* and the /health rewrite. Same routes as the local bridge.
module.exports = require('../app').handle;
