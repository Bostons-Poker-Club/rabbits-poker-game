'use strict';

// deploy trigger
// Prevent unhandled promise rejections or uncaught exceptions from killing the process
process.on('unhandledRejection', (err) => console.error('[crash] unhandledRejection:', err));
process.on('uncaughtException',  (err) => console.error('[crash] uncaughtException:',  err));

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const helmet = require('helmet');
const apiRoutes = require('./src/routes/api');
const { setupSocketHandlers, preloadActiveGames } = require('./src/socket/handlers');
const { startFeeScheduler } = require('./src/fees');
const { sendStartupTestEmail, sendStartupTestSMS } = require('./src/mail');
const maintenance = require('./src/maintenance');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  pingInterval: 25000,
  pingTimeout: 20000,
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Trust Railway's proxy so req.ip reflects the real client IP
app.set('trust proxy', 1);

// Health check must come before HTTPS redirect — Railway probes the container
// directly over HTTP, so a redirect here would return 301 instead of 200.
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/ping',   (req, res) => res.status(200).send('pong'));

// HTTPS redirect — must be before all other middleware so no request is
// processed over plain HTTP. Health check above is the only exception.
// Guard: only fire in production AND when not on localhost, to avoid loops
// if NODE_ENV is accidentally set to production in a local dev environment.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const proto = req.header('x-forwarded-proto');
    const host  = req.hostname;
    if (proto !== 'https' && host !== 'localhost' && host !== '127.0.0.1') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Security headers via helmet
app.use(helmet({
  // HSTS: tell browsers to always use HTTPS for the next year
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],   // inline scripts used throughout app
      scriptSrcAttr: ["'unsafe-inline'"],            // inline event handlers (onclick, etc.)
      styleSrc:      ["'self'", "'unsafe-inline'"],  // inline styles used throughout app
      imgSrc:      ["'self'", 'data:', 'blob:', 'https://api.qrserver.com'],
      connectSrc:  ["'self'", 'wss:', 'ws:'],       // socket.io websocket
      mediaSrc:    ["'self'", 'blob:'],
      workerSrc:   ["'self'", 'blob:'],             // service worker
      frameSrc:    ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,  // needed for some browser APIs used (WebRTC, AudioContext)
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Public maintenance state — clients poll this to show/hide the banner
app.get('/api/maintenance', (req, res) => res.json(maintenance.getState()));

// Service worker must never be cached by the browser itself
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.set('io', io);
app.set('maintenance', maintenance);
app.use('/api', apiRoutes);

// Catch-all: serve index.html for SPA-style routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

setupSocketHandlers(io);
startFeeScheduler();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🃏 Rabbits Poker running on port ${PORT}`);
  console.log('[mail] SendGrid configured:', !!process.env.SENDGRID_API_KEY, '| from:', 'bostonspokerclub.amitureflops@gmail.com');
  sendStartupTestEmail();
  sendStartupTestSMS();
  preloadActiveGames(io).catch(err => console.error('[startup] preloadActiveGames error:', err.message));

  // Self-ping every 4 minutes to prevent Railway from idling the container.
  // Always ping localhost — Railway containers cannot reach their own public domain internally.
  const _pingUrl = `http://localhost:${PORT}/ping`;
  setInterval(() => {
    require('http').get(_pingUrl, (r) => {
      console.log('[keepalive] ping →', r.statusCode);
    }).on('error', (err) => {
      console.warn('[keepalive] ping failed:', err.message);
    });
  }, 4 * 60 * 1000);
  console.log(`[keepalive] self-ping every 4 min → ${_pingUrl}`);
});
