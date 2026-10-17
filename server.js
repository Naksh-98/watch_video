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
  // roomCode -> { currentMovie: null, currentSubtitle: null }
  const roomStates = new Map();

  io.on('connection', (socket) => {
    let currentRoom = null;
    let userName = 'Anonymous';

    socket.on('join_room', ({ roomCode, name }) => {
      currentRoom = (roomCode || '').trim().toLowerCase();
      userName = (name || 'User').trim();
      socket.join(currentRoom);

      if (!rooms.has(currentRoom)) {
        rooms.set(currentRoom, new Map());
      }
      if (!roomStates.has(currentRoom)) {
        roomStates.set(currentRoom, { currentMovie: null, currentSubtitle: null });
      }

      const roomUsers = rooms.get(currentRoom);
      const state = roomStates.get(currentRoom);

      roomUsers.set(socket.id, {
        id: socket.id,
        name: userName,
        currentTime: 0,
        isPlaying: false,
        isBuffering: false,
      });

      // Notify others in room
      socket.to(currentRoom).emit('user_joined', {
        id: socket.id,
        name: userName,
        users: Array.from(roomUsers.values()),
      });

      // Send existing state to newcomer (including current movie and synced subtitles)
      socket.emit('room_info', {
        users: Array.from(roomUsers.values()),
        currentMovie: state ? state.currentMovie : null,
        currentSubtitle: state ? state.currentSubtitle : null,
      });
    });

    // Subtitle Sync across room (when host uploads or changes subtitles)
    socket.on('sync_subtitle', (data) => {
      if (currentRoom) {
        if (!roomStates.has(currentRoom)) {
          roomStates.set(currentRoom, { currentMovie: null, currentSubtitle: null });
        }
        const subtitleData = {
          vttText: data.vttText,
          filename: data.filename || 'subtitles.vtt',
          senderName: userName,
          url: `/api/room/subtitle?room=${encodeURIComponent(currentRoom)}&t=${Date.now()}`,
        };
        roomStates.get(currentRoom).currentSubtitle = subtitleData;

        // Broadcast to partner in the room
        socket.to(currentRoom).emit('subtitle_synced', subtitleData);
      }
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
        if (!roomStates.has(currentRoom)) {
          roomStates.set(currentRoom, { currentMovie: null, currentSubtitle: null });
        }
        roomStates.get(currentRoom).currentMovie = data.filename;
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

    // Chat messages
    socket.on('send_chat', ({ text }) => {
      if (currentRoom) {
        io.to(currentRoom).emit('chat_received', {
          id: Math.random().toString(),
          text,
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
          roomStates.delete(currentRoom);
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

  // ================= Live Room Subtitle API =================
  // Serves live synchronized WebVTT subtitles over standard HTTP
  // (Fixes iOS Safari / iPhone WebKit where blob: URLs are blocked in <track>)
  server.get('/api/room/subtitle', (req, res) => {
    const rawRoom = req.query.room || '';
    const roomCode = rawRoom.trim().toLowerCase();
    const state = roomStates.get(roomCode);

    if (state && state.currentSubtitle && state.currentSubtitle.vttText) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(state.currentSubtitle.vttText);
    }
    return res.status(404).send('No active subtitles for this room');
  });

  // ================= Movie Library APIs =================

  // 1. List all available movies in movies/ folder (including cloud links & subtitle detection)
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
        .filter((file) => !file.startsWith('.') && file !== 'cloud_movies.json' && !file.endsWith('.srt') && !file.endsWith('.vtt'))
        .map((file) => {
          const filePath = path.join(MOVIES_DIR, file);
          const stats = fs.statSync(filePath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
          const formattedSize = stats.size > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;

          const ext = path.extname(file);
          const baseName = path.basename(file, ext);
          const srtPath = path.join(MOVIES_DIR, `${baseName}.srt`);
          const vttPath = path.join(MOVIES_DIR, `${baseName}.vtt`);
          const hasSubtitle = fs.existsSync(srtPath) || fs.existsSync(vttPath);

          return {
            filename: file,
            size: stats.size,
            formattedSize,
            modifiedAt: stats.mtime,
            isCloud: false,
            hasSubtitle,
            subtitleUrl: hasSubtitle ? `/api/movies/subtitle/${encodeURIComponent(file)}` : null,
          };
        });

      res.json([...cloudMovies, ...localMovies]);
    });
  });

  // 1b. Serve subtitle for movie (converts .srt to .vtt on the fly for native browser support)
  server.get('/api/movies/subtitle/:filename', (req, res) => {
    const filename = req.params.filename;
    const safeFilename = path.basename(filename);
    const ext = path.extname(safeFilename);
    const baseName = path.basename(safeFilename, ext);

    const vttPath = path.join(MOVIES_DIR, `${baseName}.vtt`);
    const srtPath = path.join(MOVIES_DIR, `${baseName}.srt`);

    if (fs.existsSync(vttPath)) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return fs.createReadStream(vttPath).pipe(res);
    } else if (fs.existsSync(srtPath)) {
      try {
        const srtContent = fs.readFileSync(srtPath, 'utf-8');
        const vttContent = 'WEBVTT\n\n' + srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        return res.send(vttContent);
      } catch (err) {
        return res.status(500).send('Error reading subtitle');
      }
    } else {
      return res.status(404).send('Subtitle not found');
    }
  });

  // 1c. Subtitle upload endpoint
  server.post('/api/movies/upload-subtitle', upload.single('subtitle'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No subtitle file provided' });
    }
    res.json({
      success: true,
      filename: req.file.filename,
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
