const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3002;
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Forcer l'UTF-8 sur les pages HTML
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !req.path.includes('.')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/affichage', (req, res) => res.sendFile(path.join(__dirname, 'public', 'affichage.html')));
app.get('/passe', (req, res) => res.sendFile(path.join(__dirname, 'public', 'passe.html')));

let state = {
  code: null,
  tickets: {},
  readyTimes: {},
  lastNumber: 0,
  tvs: new Set(),
  tablets: new Set()
};

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.code = data.code || generateCode();
      state.tickets = data.tickets || {};
      state.readyTimes = data.readyTimes || {};
      state.lastNumber = data.lastNumber || 0;
    } else {
      state.code = generateCode();
    }
  } catch (e) {
    console.error('Erreur chargement state:', e);
    state.code = generateCode();
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      code: state.code,
      tickets: state.tickets,
      readyTimes: state.readyTimes,
      lastNumber: state.lastNumber
    }, null, 2));
  } catch (e) { console.error('Erreur sauvegarde state:', e); }
}

io.on('connection', (socket) => {
  console.log('Connexion:', socket.id);

  socket.on('tv:register', () => {
    state.tvs.add(socket.id);
    socket.role = 'tv';
    socket.emit('tv:registered', { code: state.code });
    socket.emit('tv:tickets-updated', { tickets: state.tickets, readyTimes: state.readyTimes });
    if (state.tablets.size > 0) socket.emit('tv:tablet-connected');
    console.log('TV connectee (total: ' + state.tvs.size + ')');
  });

  socket.on('tablet:connect', ({ code }) => {
    if (String(code) !== String(state.code)) {
      return socket.emit('tablet:error', 'Code incorrect');
    }
    state.tablets.add(socket.id);
    socket.role = 'tablet';
    socket.emit('tablet:connected', { tickets: state.tickets, lastNumber: state.lastNumber });
    socket.emit('tablet:ready-times', state.readyTimes);
    state.tvs.forEach(id => io.to(id).emit('tv:tablet-connected'));
    console.log('Tablette connectee (total: ' + state.tablets.size + ')');
  });

  socket.on('tablet:request-ready-times', () => {
    socket.emit('tablet:ready-times', state.readyTimes);
  });

  socket.on('tablet:update-tickets', ({ tickets }) => {
    if (socket.role !== 'tablet') return;
    const now = Date.now();
    const prevTickets = state.tickets;
    const newReadyTimes = {};

    Object.keys(tickets).forEach(num => {
      if (tickets[num] === 'ready') {
        if (prevTickets[num] === 'ready' && state.readyTimes[num]) {
          newReadyTimes[num] = state.readyTimes[num];
        } else {
          newReadyTimes[num] = now;
        }
      }
    });

    // Mettre a jour lastNumber si un ticket est plus grand
    Object.keys(tickets).forEach(num => {
      const n = parseInt(num, 10);
      if (!isNaN(n) && n > state.lastNumber) state.lastNumber = n;
    });

    state.tickets = tickets;
    state.readyTimes = newReadyTimes;

    state.tvs.forEach(id => io.to(id).emit('tv:tickets-updated', {
      tickets: state.tickets,
      readyTimes: state.readyTimes
    }));

    state.tablets.forEach(id => {
      if (id !== socket.id) {
        io.to(id).emit('tablet:ready-times', state.readyTimes);
      }
    });

    saveState();
  });

  // Reset de la journee
  socket.on('tablet:reset-day', () => {
    if (socket.role !== 'tablet') return;
    state.tickets = {};
    state.readyTimes = {};
    state.lastNumber = 0;

    state.tvs.forEach(id => io.to(id).emit('tv:tickets-updated', {
      tickets: {},
      readyTimes: {}
    }));

    state.tablets.forEach(id => {
      io.to(id).emit('tablet:day-reset');
    });

    saveState();
    console.log('Journee reinitialisee par ' + socket.id);
  });

  socket.on('tv:request-state', () => {
    if (socket.role !== 'tv') return;
    socket.emit('tv:tickets-updated', { tickets: state.tickets, readyTimes: state.readyTimes });
  });

  socket.on('disconnect', () => {
    if (socket.role === 'tv') {
      state.tvs.delete(socket.id);
      console.log('TV deconnectee (total: ' + state.tvs.size + ')');
    } else if (socket.role === 'tablet') {
      state.tablets.delete(socket.id);
      state.tvs.forEach(id => io.to(id).emit('tv:tablet-disconnected'));
      console.log('Tablette deconnectee (total: ' + state.tablets.size + ')');
    }
  });
});

loadState();
server.listen(PORT, '0.0.0.0', () => {
  console.log('Serveur demarre sur http://0.0.0.0:' + PORT);
  console.log('Code appairage : ' + state.code);
});