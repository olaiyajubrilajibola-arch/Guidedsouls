'use strict';
// Vercel entry point: every /api/... request is routed here (see vercel.json). Pages are served as static files.
const { createApp } = require('./_app/server');

let appPromise = null;
module.exports = async (req, res) => {
  if (!appPromise) appPromise = createApp().catch((e) => { appPromise = null; throw e; });
  let app;
  try { app = await appPromise; } catch (e) {
    console.error(e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'The website could not connect to its database. Check the Turso connection in Vercel and redeploy.' }));
    return;
  }
  return app.handler(req, res);
};
