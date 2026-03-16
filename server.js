const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const User = require('./models/User');
const Message = require('./models/Message');
const { auth, generateToken, JWT_SECRET } = require('./middleware/auth');

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
        .populate('sender', 'username')
        .populate('recipient', 'username');

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
        .populate('sender', 'username')
        .populate('recipient', 'username')
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