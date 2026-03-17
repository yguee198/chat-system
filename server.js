const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const User = require('./models/User');
const Message = require('./models/Message');
const { auth, generateToken, JWT_SECRET } = require('./middleware/auth');

// Ensure uploads directory exists
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${req.user._id}-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Nodemailer transporter configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Base URL for verification emails
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp';

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log('MongoDB connection error:', err.message));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/messages', require('./routes/messages'));

// Profile upload endpoint
app.post('/api/users/upload-profile', auth, upload.single('profileImage'), async (req, res) => {
  try {
    console.log('Upload request received, file:', req.file);
    console.log('User ID:', req.user._id);

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const profileImagePath = `/uploads/${req.file.filename}`;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { profileImage: profileImagePath },
      { new: true }
    );

    console.log('Updated user profileImage:', user.profileImage);

    // Return user without password
    const userObj = user.toObject();
    delete userObj.password;

    res.json(userObj);
  } catch (error) {
    console.log('Upload error:', error);
    res.status(500).json({ message: 'Upload error', error: error.message });
  }
}, (error, req, res, next) => {
  console.log('Multer error:', error);
  res.status(400).json({ message: error.message });
});

// Email verification endpoint
app.get('/api/auth/verify/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      verificationToken: req.params.token,
      verificationExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-slate-900 min-h-screen flex items-center justify-center">
          <div class="bg-slate-800 p-8 rounded-2xl text-center">
            <h1 class="text-2xl font-bold text-red-400 mb-4">Invalid or Expired Link</h1>
            <p class="text-slate-300 mb-4">This verification link is invalid or has expired.</p>
            <a href="/" class="text-indigo-400 hover:text-indigo-300">Go to Login</a>
          </div>
        </body>
        </html>
      `);
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationExpires = undefined;
    await user.save();

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-900 min-h-screen flex items-center justify-center">
        <div class="bg-slate-800 p-8 rounded-2xl text-center">
          <h1 class="text-2xl font-bold text-green-400 mb-4">Email Verified!</h1>
          <p class="text-slate-300 mb-4">Your email has been verified. You can now log in.</p>
          <a href="/" class="text-indigo-400 hover:text-indigo-300">Go to Login</a>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Server error');
  }
});


// Socket.io logic
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User login via socket
  socket.on('user:join', async (token) => {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);

      if (user) {
        onlineUsers.set(user._id.toString(), socket.id);
        socket.userId = user._id.toString();

        // Update online status in database
        await User.findByIdAndUpdate(user._id, { isOnline: true });

        // Notify others
        socket.broadcast.emit('user:online', user._id.toString());

        // Send list of online users
        const onlineUserIds = Array.from(onlineUsers.keys());
        socket.emit('users:online', onlineUserIds);

        console.log(`User ${user.username} joined`);
      }
    } catch (error) {
      console.log('Socket auth error:', error.message);
    }
  });

  // Send message
  socket.on('message:send', async (data) => {
    try {
      const { recipientId, content, senderId } = data;

      // Save to database
      const message = new Message({
        sender: senderId,
        recipient: recipientId,
        content
      });
      await message.save();

      const populatedMessage = await Message.findById(message._id)
        .populate('sender', 'username profileImage')
        .populate('recipient', 'username profileImage');

      // Send to recipient if online
      const recipientSocketId = onlineUsers.get(recipientId);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('message:receive', populatedMessage);
      }

      // Send back to sender
      socket.emit('message:sent', populatedMessage);
    } catch (error) {
      console.log('Message send error:', error.message);
    }
  });

  // Get chat history via socket
  socket.on('message:history', async (data) => {
    try {
      const { userId1, userId2 } = data;

      const messages = await Message.find({
        $or: [
          { sender: userId1, recipient: userId2 },
          { sender: userId2, recipient: userId1 }
        ]
      })
        .populate('sender', 'username profileImage')
        .populate('recipient', 'username profileImage')
        .sort({ createdAt: 1 });

      socket.emit('message:history', messages);
    } catch (error) {
      console.log('History error:', error.message);
    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);

      // Update offline status
      await User.findByIdAndUpdate(socket.userId, {
        isOnline: false,
        lastSeen: new Date()
      });

      // Notify others
      socket.broadcast.emit('user:offline', socket.userId);

      console.log(`User ${socket.userId} disconnected`);
    }
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});