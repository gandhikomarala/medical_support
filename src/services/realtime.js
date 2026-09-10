const { WebSocketServer, WebSocket } = require('ws');

let wss = null;
const rooms = new Map(); // roomName -> Set<WebSocket>

/**
 * Attach WebSocket Server to an existing HTTP server
 */
function initRealtime(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.rooms = new Set();
    ws.userInfo = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(ws, msg);
      } catch (err) {
        console.warn('[ws] Malformed client message:', err.message);
      }
    });

    ws.on('close', () => {
      leaveAllRooms(ws);
    });

    ws.on('error', (err) => {
      console.warn('[ws] Socket error:', err.message);
      leaveAllRooms(ws);
    });

    // Send initial connected handshake
    sendJson(ws, { type: 'connected', time: new Date().toISOString() });
  });

  // Heartbeat interval to drop dead sockets
  const interval = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        leaveAllRooms(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  console.log('⚡ Real-time WebSocket Hub initialized on /ws');
  return wss;
}

function handleMessage(ws, msg) {
  if (!msg || !msg.action) return;

  switch (msg.action) {
    case 'join': {
      if (msg.role) {
        joinRoom(ws, `role:${msg.role}`);
      }
      if (msg.phone) {
        joinRoom(ws, `user:${String(msg.phone).replace(/[^0-9]/g, '')}`);
      }
      ws.userInfo = { role: msg.role, phone: msg.phone };
      sendJson(ws, {
        type: 'subscribed',
        rooms: Array.from(ws.rooms),
        time: new Date().toISOString()
      });
      break;
    }

    case 'leave': {
      if (msg.room) {
        leaveRoom(ws, msg.room);
      }
      break;
    }

    case 'ping': {
      sendJson(ws, { type: 'pong', time: new Date().toISOString() });
      break;
    }

    default:
      break;
  }
}

function joinRoom(ws, roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  rooms.get(roomName).add(ws);
  ws.rooms.add(roomName);
}

function leaveRoom(ws, roomName) {
  if (rooms.has(roomName)) {
    rooms.get(roomName).delete(ws);
    if (rooms.get(roomName).size === 0) {
      rooms.delete(roomName);
    }
  }
  ws.rooms.delete(roomName);
}

function leaveAllRooms(ws) {
  for (const roomName of ws.rooms) {
    if (rooms.has(roomName)) {
      rooms.get(roomName).delete(ws);
      if (rooms.get(roomName).size === 0) {
        rooms.delete(roomName);
      }
    }
  }
  ws.rooms.clear();
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Broadcast an event to a room or globally
 */
function broadcast(targetRoom, eventName, payload = {}) {
  const message = JSON.stringify({
    type: 'event',
    event: eventName,
    room: targetRoom,
    payload,
    timestamp: new Date().toISOString()
  });

  if (!targetRoom || targetRoom === '*') {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
    return;
  }

  const clientSet = rooms.get(targetRoom);
  if (!clientSet || clientSet.size === 0) return;

  for (const ws of clientSet) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function getStats() {
  return {
    clientsCount: wss ? wss.clients.size : 0,
    roomsCount: rooms.size,
    rooms: Array.from(rooms.keys())
  };
}

module.exports = {
  initRealtime,
  broadcast,
  getStats
};
