require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const amqp = require('amqplib');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Enable CORS for all routes
app.use(cors({
  origin: 'http://localhost:3002',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Handle preflight requests
app.options('*', cors());

const upload = multer();
// Initialize Redis with retry strategy and error handling
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    retryStrategy: (times) => {
        const delay = Math.min(times * 100, 5000);
        console.log(`[Redis] Connection failed. Retrying in ${delay}ms...`);
        return delay;
    },
    maxRetriesPerRequest: null,
});

redis.on('error', (err) => {
    console.error('[Redis] Error:', err.message);
});

redis.on('connect', async () => {
    console.log('[Redis] Connected successfully to Redis server');
    console.log(`[Redis] Server: ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
    console.log(`[Redis] Status: ${redis.status}`);
    
    try {
        const memoryInfo = await redis.info('memory');
        const keysCount = await redis.dbsize();
        console.log('[Redis] Memory Info:', memoryInfo.split('\n').filter(line => 
            line.startsWith('used_memory') || 
            line.startsWith('maxmemory') ||
            line.startsWith('mem_fragmentation_ratio')
        ).join('\n'));
        console.log(`[Redis] Total keys in database: ${keysCount}`);
    } catch (err) {
        console.error('[Redis] Error getting memory info:', err.message);
    }
});

const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const QUEUE = 'upload_progress';

// --- MongoDB Setup ---
mongoose.connect(process.env.MONGODB_URI);

const FileSchema = new mongoose.Schema({
    fileId: String,
    filename: String,
    totalSize: Number,
    uploadedBy: String,
    uploadedAt: { type: Date, default: Date.now },
    path: String,
});

const File = mongoose.model('File', FileSchema);

// --- Ensure upload directory exists ---
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// --- WebSocket Server ---
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Start the server on WS_PORT
server.listen(WS_PORT, () => {
    console.log(`WebSocket server listening on port ${WS_PORT}`);
});

// Handle server errors
server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${WS_PORT} is already in use. Please choose a different port.`);
    }
});

// Add CORS headers to WebSocket
wss.on('headers', (headers) => {
  headers.push('Access-Control-Allow-Origin', 'http://localhost:3002');
  headers.push('Access-Control-Allow-Credentials', 'true');
  headers.push('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.push('Access-Control-Max-Age', '86400');
  headers.push('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.push('Vary', 'Origin');
  headers.push('Access-Control-Expose-Headers', 'Content-Type, Authorization');
  headers.push('Access-Control-Allow-Private-Network', 'true');
  headers.push('Access-Control-Allow-Integrity', 'true');
  headers.push('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.push('Cross-Origin-Opener-Policy', 'same-origin');
  headers.push('Cross-Origin-Embedder-Policy', 'credentialless');
});

const wsClients = new Set();

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[WebSocket] New connection from ${clientIp}, total clients: ${wsClients.size + 1}`);
    
    wsClients.add(ws);
    
    ws.on('close', () => {
        wsClients.delete(ws);
        console.log(`[WebSocket] Client disconnected, remaining clients: ${wsClients.size}`);
    });
    
    ws.on('error', (error) => {
        console.error('[WebSocket] Error:', error.message);
    });
    
    console.log(`[WebSocket] Sending welcome message to client`);
    ws.send(JSON.stringify({ type: 'connection', message: 'Connected to WebSocket server' }));
});

// --- RabbitMQ Helper Functions ---
async function publishProgress(fileId, progress) {
    try {
        console.log(`[RabbitMQ] Connecting to ${RABBITMQ_URL}`);
        const conn = await amqp.connect(RABBITMQ_URL);
        console.log('[RabbitMQ] Connection established, creating channel');
        const channel = await conn.createChannel();
        
        console.log(`[RabbitMQ] Asserting queue: ${QUEUE}`);
        await channel.assertQueue(QUEUE, { durable: true });
        
        const message = { fileId, progress };
        console.log(`[RabbitMQ] Publishing progress update for file ${fileId}: ${progress}%`);
        
        channel.sendToQueue(
            QUEUE,
            Buffer.from(JSON.stringify(message)),
            { persistent: true }
        );
        
        console.log('[RabbitMQ] Message published, closing connection');
        setTimeout(() => {
            channel.close();
            conn.close();
            console.log('[RabbitMQ] Connection closed');
        }, 500);
    } catch (error) {
        console.error('[RabbitMQ] Error in publishProgress:', error.message);
        throw error;
    }
}

async function consumeProgress() {
    try {
        console.log(`[RabbitMQ] Consumer connecting to ${RABBITMQ_URL}`);
        const conn = await amqp.connect(RABBITMQ_URL);
        console.log('[RabbitMQ] Consumer connection established, creating channel');
        const channel = await conn.createChannel();
        
        console.log(`[RabbitMQ] Consumer asserting queue: ${QUEUE}`);
        await channel.assertQueue(QUEUE, { durable: true });
        
        console.log('[RabbitMQ] Consumer waiting for messages...');
        channel.consume(QUEUE, async (msg) => {
            if (msg) {
                const message = JSON.parse(msg.content.toString());
                const { fileId, progress } = message;
                
                console.log(`[RabbitMQ] Received progress update for file ${fileId}: ${progress}%`);
                
                // Store in Redis
                console.log(`[Redis] Storing progress for file ${fileId}: ${progress}%`);
                const redisKey = `upload_progress:${fileId}`;
                const ttl = 86400; // 24 hours TTL
                
                console.log(`[Redis] Key: ${redisKey}`);
                console.log(`[Redis] Value: ${progress}`);
                console.log(`[Redis] Setting TTL: ${ttl} seconds`);
                
                // Set value with TTL
                await redis.setex(redisKey, ttl, progress);
                
                // Get key information using standard commands
                try {
                    const keyType = await redis.type(redisKey);
                    const keyTTL = await redis.ttl(redisKey);
                    const keyValue = await redis.get(redisKey);
                    
                    console.log(`[Redis] Key: ${redisKey}`);
                    console.log(`[Redis] Type: ${keyType}`);
                    console.log(`[Redis] Value: ${keyValue}`);
                    console.log(`[Redis] TTL: ${keyTTL} seconds`);
                    
                    // Memory usage (if available)
                    try {
                        const memoryUsage = await redis.memory('USAGE', redisKey);
                        console.log(`[Redis] Memory used: ${memoryUsage} bytes`);
                    } catch (memError) {
                        console.log('[Redis] Memory usage not available (requires Redis 4+ with memory profiling)');
                    }
                } catch (err) {
                    console.error('[Redis] Error getting key info:', err.message);
                }
                
                // Push to WebSocket clients
                const activeClients = Array.from(wsClients).filter(client => 
                    client.readyState === WebSocket.OPEN
                );
                
                console.log(`[WebSocket] Broadcasting to ${activeClients.length} active clients`);
                const wsMessage = JSON.stringify({ fileId, progress, timestamp: new Date().toISOString() });
                
                activeClients.forEach((client, index) => {
                    try {
                        client.send(wsMessage);
                        console.log(`[WebSocket] Sent update to client ${index + 1}/${activeClients.length}`);
                    } catch (error) {
                        console.error(`[WebSocket] Error sending to client ${index + 1}:`, error.message);
                    }
                });
                
                channel.ack(msg);
                console.log(`[RabbitMQ] Acknowledged message for file ${fileId}`);
            }
        });
        
        // Handle connection errors
        conn.on('error', (error) => {
            console.error('[RabbitMQ] Connection error:', error.message);
        });
        
        conn.on('close', () => {
            console.log('[RabbitMQ] Connection closed, attempting to reconnect...');
            setTimeout(consumeProgress, 5000);
        });
        
    } catch (error) {
        console.error('[RabbitMQ] Error in consumeProgress:', error.message);
        console.log('[RabbitMQ] Will retry in 5 seconds...');
        setTimeout(consumeProgress, 5000);
    }
}

// Start consuming RabbitMQ messages with error handling
async function setupRabbitMQ() {
    try {
        // Log Redis memory info before starting
        try {
            const memoryInfo = await redis.info('memory');
            console.log('[Redis] Current Memory Usage:');
            memoryInfo.split('\n')
                .filter(line => line.startsWith('used_memory') || line.startsWith('maxmemory'))
                .forEach(line => console.log(`[Redis] ${line}`));
        } catch (err) {
            console.error('[Redis] Error getting initial memory info:', err.message);
        }
        
        await consumeProgress();
        console.log('[RabbitMQ] Consumer started');
    } catch (error) {
        console.error('[RabbitMQ] Error in setup:', error.message);
        console.log('[RabbitMQ] Retrying in 5 seconds...');
        setTimeout(setupRabbitMQ, 5000);
    }
}

// Start RabbitMQ with delay to allow time for service to start
setTimeout(() => {
    setupRabbitMQ();
}, 2000);

// --- Express Routes ---

// Upload chunk endpoint
app.post('/upload', upload.single('chunk'), async (req, res) => {
    try {
        const { fileId, totalSize, startByte, filename, userId } = req.body;
        const chunk = req.file.buffer;
        const filePath = path.join(UPLOAD_DIR, fileId);

        // Append chunk at correct offset
        const fd = fs.openSync(filePath, 'a+');
        fs.writeSync(fd, chunk, 0, chunk.length, parseInt(startByte));
        fs.closeSync(fd);

        const uploadedSize = fs.statSync(filePath).size;
        const progress = Math.floor((uploadedSize / parseInt(totalSize)) * 100);

        // Update Redis
        await redis.set(`upload_progress:${fileId}`, uploadedSize);

        // Publish progress to RabbitMQ
        await publishProgress(fileId, progress);

        // If upload complete, store metadata in MongoDB
        if (uploadedSize >= parseInt(totalSize)) {
            await File.create({
                fileId,
                filename,
                totalSize,
                uploadedBy: userId,
                path: filePath,
            });
        }

        res.json({ status: 'ok', uploadedSize, progress });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Resume status endpoint
app.get('/upload/status/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const uploadedSize = await redis.get(`upload_progress:${fileId}`) || 0;
    res.json({ uploadedSize: parseInt(uploadedSize) });
});

// Start Express server
app.listen(PORT, () => console.log(`HTTP server running on http://localhost:${PORT}`));
