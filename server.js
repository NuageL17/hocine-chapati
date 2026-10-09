const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL;

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !req.path.includes('.')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/affichage', (req, res) => res.sendFile(path.join(__dirname, 'public', 'affichage.html')));
app.get('/passe', (req, res) => res.sendFile(path.join(__dirname, 'public', 'passe.html')));

const TicketSchema = new mongoose.Schema({
  num: { type: Number, required: true, index: true },
  status: { type: String, enum: ['prep', 'ready'], default: 'prep' },
  created: Date,
  ready: Date,
  retrieved: Date,
  day: { type: String, index: true }
}, { timestamps: true });

const Ticket = mongoose.model('Ticket', TicketSchema);

const ConfigSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const Config = mongoose.model('Config', ConfigSchema);

let state = {
  code: null,
  tickets: {},
  readyTimes: {},
  createdTimes: {},
  lastNumber: 0,
  tvs: new Set(),
  tablets: new Set()
};

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function loadStateFromDB() {
  try {
    let codeDoc = await Config.findOne({ key: 'pairing_code' });
    if (!codeDoc) {
      codeDoc = await Config.create({ key: 'pairing_code', value: generateCode() });
    }
    state.code = codeDoc.value;

    const activeTickets = await Ticket.find({ retrieved: null });
    activeTickets.forEach(t => {
      state.tickets[t.num] = t.status;
      if (t.created) state.createdTimes[t.num] = t.created.getTime();
      if (t.ready) state.readyTimes[t.num] = t.ready.getTime();
      if (t.num > state.lastNumber) state.lastNumber = t.num;
    });

    const lastNumDoc = await Config.findOne({ key: 'last_number' });
    if (lastNumDoc) state.lastNumber = Math.max(state.lastNumber, lastNumDoc.value);

    console.log('[DB] Etat charge: ' + activeTickets.length + ' tickets actifs, code=' + state.code);
  } catch (e) {
    console.error('[DB] Erreur chargement:', e);
    if (!state.code) state.code = generateCode();
  }
}

async function saveLastNumber() {
  try {
    await Config.findOneAndUpdate({ key: 'last_number' }, { value: state.lastNumber }, { upsert: true });
  } catch (e) { console.error('[DB] Erreur saveLastNumber:', e); }
}

async function upsertTicket(num, status, createdTs, readyTs) {
  try {
    const update = { status, day: todayKey() };
    if (createdTs) update.created = new Date(createdTs);
    if (readyTs) update.ready = new Date(readyTs);
    await Ticket.findOneAndUpdate(
      { num, retrieved: null },
      { $set: update, $setOnInsert: { num } },
      { upsert: true, new: true }
    );
  } catch (e) { console.error('[DB] Erreur upsertTicket:', e); }
}

async function markRetrieved(num, retrievedTs) {
  try {
    await Ticket.findOneAndUpdate(
      { num, retrieved: null },
      { $set: { retrieved: new Date(retrievedTs) } }
    );
  } catch (e) { console.error('[DB] Erreur markRetrieved:', e); }
}

io.on('connection', (socket) => {
  console.log('Connexion:', socket.id);

  socket.on('tv:register', () => {
    state.tvs.add(socket.id);
    socket.role = 'tv';
    socket.emit('tv:registered', { code: state.code });
    socket.emit('tv:tickets-updated', { tickets: state.tickets, readyTimes: state.readyTimes });
    if (state.tablets.size > 0) socket.emit('tv:tablet-connected');
  });

  socket.on('tablet:connect', ({ code }) => {
    if (String(code) !== String(state.code)) return socket.emit('tablet:error', 'Code incorrect');
    state.tablets.add(socket.id);
    socket.role = 'tablet';
    socket.emit('tablet:connected', { tickets: state.tickets, lastNumber: state.lastNumber });
    socket.emit('tablet:ready-times', state.readyTimes);
    state.tvs.forEach(id => io.to(id).emit('tv:tablet-connected'));
  });

  socket.on('tablet:request-ready-times', () => {
    socket.emit('tablet:ready-times', state.readyTimes);
  });

  socket.on('tablet:request-stats', async () => {
    socket.emit('tablet:stats', await getStats());
  });

  socket.on('tablet:update-tickets', async ({ tickets }) => {
    if (socket.role !== 'tablet') return;
    const now = Date.now();
    const prevTickets = state.tickets;
    const newReadyTimes = {};
    const newCreatedTimes = {};

    Object.keys(tickets).forEach(num => {
      if (prevTickets[num] === undefined) newCreatedTimes[num] = now;
      else if (state.createdTimes[num]) newCreatedTimes[num] = state.createdTimes[num];
      else newCreatedTimes[num] = now;

      if (tickets[num] === 'ready') {
        if (prevTickets[num] === 'ready' && state.readyTimes[num]) newReadyTimes[num] = state.readyTimes[num];
        else newReadyTimes[num] = now;
      }
    });

    for (const num of Object.keys(prevTickets)) {
      if (tickets[num] === undefined) await markRetrieved(parseInt(num, 10), now);
    }

    for (const num of Object.keys(tickets)) {
      const n = parseInt(num, 10);
      const wasExisting = prevTickets[num] !== undefined;
      const statusChanged = prevTickets[num] !== tickets[num];
      if (!wasExisting || statusChanged) {
        await upsertTicket(n, tickets[num], newCreatedTimes[num], newReadyTimes[num]);
      }
      if (n > state.lastNumber) state.lastNumber = n;
    }

    if (state.lastNumber > 0) await saveLastNumber();

    state.tickets = tickets;
    state.readyTimes = newReadyTimes;
    state.createdTimes = newCreatedTimes;

    state.tvs.forEach(id => io.to(id).emit('tv:tickets-updated', { tickets: state.tickets, readyTimes: state.readyTimes }));
    state.tablets.forEach(id => { if (id !== socket.id) io.to(id).emit('tablet:ready-times', state.readyTimes); });
  });

  socket.on('tablet:reset-day', async () => {
    if (socket.role !== 'tablet') return;
    state.tickets = {}; state.readyTimes = {}; state.createdTimes = {}; state.lastNumber = 0;
    try { await Ticket.deleteMany({ retrieved: null }); } catch (e) { console.error(e); }
    await saveLastNumber();
    state.tvs.forEach(id => io.to(id).emit('tv:tickets-updated', { tickets: {}, readyTimes: {} }));
    state.tablets.forEach(id => io.to(id).emit('tablet:day-reset'));
  });

  socket.on('tv:request-state', () => {
    if (socket.role !== 'tv') return;
    socket.emit('tv:tickets-updated', { tickets: state.tickets, readyTimes: state.readyTimes });
  });

  socket.on('disconnect', () => {
    if (socket.role === 'tv') state.tvs.delete(socket.id);
    else if (socket.role === 'tablet') {
      state.tablets.delete(socket.id);
      state.tvs.forEach(id => io.to(id).emit('tv:tablet-disconnected'));
    }
  });
});

async function getStats() {
  try {
    const day = todayKey();
    const served = await Ticket.find({ day, retrieved: { $ne: null } }).sort({ retrieved: 1 });
    const totalServed = served.length;
    const prepDurations = served.filter(t => t.created && t.ready).map(t => t.ready.getTime() - t.created.getTime());
    const avgPrep = prepDurations.length > 0 ? Math.round(prepDurations.reduce((a, b) => a + b, 0) / prepDurations.length) : 0;
    const waitDurations = served.filter(t => t.ready && t.retrieved).map(t => t.retrieved.getTime() - t.ready.getTime());
    const avgWait = waitDurations.length > 0 ? Math.round(waitDurations.reduce((a, b) => a + b, 0) / waitDurations.length) : 0;
    const createdTimes = served.filter(t => t.created).map(t => t.created.getTime());
    const firstOrder = createdTimes.length > 0 ? Math.min(...createdTimes) : null;
    const lastOrder = createdTimes.length > 0 ? Math.max(...createdTimes) : null;
    const byHour = {};
    served.forEach(t => {
      if (t.created) {
        const key = String(t.created.getHours()).padStart(2, '0') + 'h';
        byHour[key] = (byHour[key] || 0) + 1;
      }
    });
    const recent = served.slice(-20).reverse().map(t => ({
      num: t.num,
      created: t.created ? t.created.getTime() : null,
      ready: t.ready ? t.ready.getTime() : null,
      retrieved: t.retrieved ? t.retrieved.getTime() : null
    }));
    const inProgress = Object.keys(state.tickets).filter(k => state.tickets[k] === 'prep').length;
    const readyNow = Object.keys(state.tickets).filter(k => state.tickets[k] === 'ready').length;
    return { totalServed, inProgress, readyNow, avgPrep, avgWait, firstOrder, lastOrder, byHour, recent, now: Date.now() };
  } catch (e) {
    console.error('[DB] Erreur getStats:', e);
    return { totalServed: 0, inProgress: 0, readyNow: 0, avgPrep: 0, avgWait: 0, firstOrder: null, lastOrder: null, byHour: {}, recent: [], now: Date.now() };
  }
}

async function start() {
  if (!MONGO_URL) {
    console.error('ERREUR: MONGO_URL manquant - verifie les Environment Variables sur Render');
    process.exit(1);
  }
  try {
    console.log('Tentative de connexion a MongoDB...');
    await mongoose.connect(MONGO_URL);
    console.log('Connecte a MongoDB');
    await loadStateFromDB();
  } catch (e) {
    console.error('Erreur MongoDB:', e.message);
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log('Serveur demarre sur http://0.0.0.0:' + PORT);
    console.log('Code appairage : ' + state.code);
  });
}

start();