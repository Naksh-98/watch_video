const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const next = require('next');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = process.env.PORT || 3000;
const MOVIES_DIR = path.join(__dirname, 'movies');
const CLOUD_MOVIES_FILE = path.join(MOVIES_DIR, 'cloud_movies.json');

// Ensure movies directory exists
if (!fs.existsSync(MOVIES_DIR)) {
  fs.mkdirSync(MOVIES_DIR, { recursive: true });
}

// Multer storage for uploaded video files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, MOVIES_DIR);
  },
  filename: (req, file, cb) => {
    // Preserve original filename sanitized
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, sanitized);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // 50GB max
});

app.prepare().then(() => {
  const server = express();
  const httpServer = http.createServer(server);

  server.use(cors());
  server.use(express.json());

  // Socket.IO setup
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Track rooms and members
  // roomCode -> { users: Map(socketId, { name, currentTime, isPlaying, isBuffering }) }
  const rooms = new Map();

  io.on('connection', (socket) => {
    let currentRoom = null;
    let userName = 'Anonymous';

    socket.on('join_room', ({ roomCode, name }) => {
      currentRoom = roomCode;
      userName = name || 'User';
      socket.join(roomCode);

      if (!rooms.has(roomCode)) {
        rooms.set(roomCode, new Map());
      }
      const roomUsers = rooms.get(roomCode);
      roomUsers.set(socket.id, {
        id: socket.id,
        name: userName,
        currentTime: 0,
        isPlaying: false,
        isBuffering: false,
      });

      // Notify others in room
      socket.to(roomCode).emit('user_joined', {
        id: socket.id,
        name: userName,
        users: Array.from(roomUsers.values()),
      });

      // Send existing state to newcomer
      socket.emit('room_info', {
        users: Array.from(roomUsers.values()),
      });
    });

    // Player Play / Pause / Seek events
    socket.on('sync_action', (data) => {
      // Broadcast to everyone else in the room
      if (currentRoom) {
        socket.to(currentRoom).emit('sync_action', {
          ...data,
          senderId: socket.id,
          senderName: userName,
        });
      }
    });

    // Continuous heartbeat for partner time HUD
    socket.on('heartbeat', (data) => {
      if (currentRoom && rooms.has(currentRoom)) {
        const user = rooms.get(currentRoom).get(socket.id);
        if (user) {
          user.currentTime = data.currentTime;
          user.isPlaying = data.isPlaying;
          user.isBuffering = data.isBuffering;
        }

        socket.to(currentRoom).emit('partner_heartbeat', {
          senderId: socket.id,
          senderName: userName,
          currentTime: data.currentTime,
          isPlaying: data.isPlaying,
          isBuffering: data.isBuffering,
        });
      }
    });

    // Buffering state (if partner buffers, pause & notify other)
    socket.on('buffer_change', (data) => {
      if (currentRoom) {
        socket.to(currentRoom).emit('buffer_change', {
          senderId: socket.id,
          senderName: userName,
          isBuffering: data.isBuffering,
        });
      }
    });

    // Video Selection across room
    socket.on('select_movie', (data) => {
      if (currentRoom) {
        io.to(currentRoom).emit('movie_selected', {
          ...data,
          senderName: userName,
        });
      }
    });

    // WebRTC Voice Call Signaling
    socket.on('webrtc_offer', ({ targetId, offer }) => {
      io.to(targetId).emit('webrtc_offer', {
        senderId: socket.id,
        senderName: userName,
        offer,
      });
    });

    socket.on('webrtc_answer', ({ targetId, answer }) => {
      io.to(targetId).emit('webrtc_answer', {
        senderId: socket.id,
        answer,
      });
    });

    socket.on('webrtc_ice', ({ targetId, candidate }) => {
      io.to(targetId).emit('webrtc_ice', {
        senderId: socket.id,
        candidate,
      });
    });

    // Reaction emojis & Quick Chat
    socket.on('send_reaction', ({ emoji }) => {
      if (currentRoom) {
        io.to(currentRoom).emit('reaction_received', {
          emoji,
          senderName: userName,
          timestamp: Date.now(),
        });
      }
    });

    socket.on('disconnect', () => {
      if (currentRoom && rooms.has(currentRoom)) {
        const roomUsers = rooms.get(currentRoom);
        roomUsers.delete(socket.id);
        if (roomUsers.size === 0) {
          rooms.delete(currentRoom);
        } else {
          socket.to(currentRoom).emit('user_left', {
            id: socket.id,
            name: userName,
            users: Array.from(roomUsers.values()),
          });
        }
      }
    });
  });

  // ================= Movie Library APIs =================

  // 1. List all available movies in movies/ folder (including cloud links)
  server.get('/api/movies', (req, res) => {
    let cloudMovies = [];
    if (fs.existsSync(CLOUD_MOVIES_FILE)) {
      try {
        cloudMovies = JSON.parse(fs.readFileSync(CLOUD_MOVIES_FILE, 'utf-8'));
      } catch (e) {}
    }

    fs.readdir(MOVIES_DIR, (err, files) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to read movies directory' });
      }

      const localMovies = files
        .filter((file) => !file.startsWith('.') && file !== 'cloud_movies.json')
        .map((file) => {
          const filePath = path.join(MOVIES_DIR, file);
          const stats = fs.statSync(filePath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
          const formattedSize = stats.size > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;

          return {
            filename: file,
            size: stats.size,
            formattedSize,
            modifiedAt: stats.mtime,
            isCloud: false,
          };
        });

      res.json([...cloudMovies, ...localMovies]);
    });
  });

  // 2. Upload video file
  server.post('/api/movies/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    res.json({
      success: true,
      filename: req.file.filename,
      size: req.file.size,
    });
  });

  // 2b. Add Cloud Movie URL
  server.post('/api/movies/cloud', (req, res) => {
    const { url, filename } = req.body;
    if (!url || !filename) return res.status(400).json({ error: 'Missing url or filename' });

    let cloudMovies = [];
    if (fs.existsSync(CLOUD_MOVIES_FILE)) {
      try { cloudMovies = JSON.parse(fs.readFileSync(CLOUD_MOVIES_FILE, 'utf-8')); } catch (e) {}
    }

    if (!cloudMovies.find(m => m.url === url)) {
      cloudMovies.unshift({
        filename: filename,
        url: url,
        size: 0,
        formattedSize: 'Cloud Stream',
        modifiedAt: new Date().toISOString(),
        isCloud: true
      });
      fs.writeFileSync(CLOUD_MOVIES_FILE, JSON.stringify(cloudMovies, null, 2));
    }
    res.json({ success: true });
  });

  // 3. Delete video file (Keep PC storage clean) or Cloud Link
  server.delete('/api/movies/:filename', (req, res) => {
    const filename = req.params.filename;

    // Check if it's a cloud movie first
    let cloudMovies = [];
    if (fs.existsSync(CLOUD_MOVIES_FILE)) {
      try { cloudMovies = JSON.parse(fs.readFileSync(CLOUD_MOVIES_FILE, 'utf-8')); } catch (e) {}
      const cloudIndex = cloudMovies.findIndex(m => m.filename === filename);
      if (cloudIndex !== -1) {
        cloudMovies.splice(cloudIndex, 1);
        fs.writeFileSync(CLOUD_MOVIES_FILE, JSON.stringify(cloudMovies, null, 2));
        return res.json({ success: true, message: 'Cloud link removed' });
      }
    }

    // Otherwise, local file deletion
    const safeFilename = path.basename(filename);
    const filePath = path.join(MOVIES_DIR, safeFilename);

    if (fs.existsSync(filePath) && safeFilename !== 'cloud_movies.json') {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'Movie deleted successfully' });
    } else {
      return res.status(404).json({ error: 'File not found' });
    }
  });

  // 4. Download video file (Allows partner on Android to pre-download for ZERO buffering!)
  server.get('/api/movies/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const safeFilename = path.basename(filename);
    const filePath = path.join(MOVIES_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, safeFilename);
  });

  // 5. Video Streaming with HTTP 206 Partial Content (Supports Range Headers for seeking)
  server.get('/api/movies/stream/:filename', (req, res) => {
    const filename = req.params.filename;
    const safeFilename = path.basename(filename);
    const filePath = path.join(MOVIES_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // MIME type based on extension
    const ext = path.extname(safeFilename).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/webm', // modern browsers play mkv via webm container or standard video
      '.ogg': 'video/ogg',
      '.mov': 'video/quicktime',
    };
    const contentType = mimeTypes[ext] || 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
        return;
      }

      const chunksize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };

      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': contentType,
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // Delegate all remaining requests to Next.js
  server.all('*', (req, res) => {
    return handle(req, res);
  });

  httpServer.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${PORT}`);
    console.log(`> Movies stored locally in: ${MOVIES_DIR}`);
  });
});
