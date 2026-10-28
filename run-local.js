'use strict';
// Runs the website on this computer:  npm start   (or: node --disable-warning=ExperimentalWarning run-local.js)
const http = require('http');
const { createApp } = require('./api/_app/server');

createApp().then((app) => {
  app.startBackground();
  const port = Number(process.env.PORT || 3000);
  http.createServer(app.handler).listen(port, () => {
    console.log(`School CBT running on http://localhost:${port}  (storage: ${app.db.driver})`);
    console.log(`  Students:  http://localhost:${port}/`);
    console.log(`  Teachers:  http://localhost:${port}/teacher`);
  });
}).catch((e) => { console.error(e); process.exit(1); });
