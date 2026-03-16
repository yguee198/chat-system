const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const { auth } = require('../middleware/auth');

// Get messages between current user and another user
router.get('/:userId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const currentUserId = req.user._id;

    const messages = await Message.find({
      $or: [
        { sender: currentUserId, recipient: userId },
        { sender: userId, recipient: currentUserId }
      ]
    })
      .populate('sender', 'username')
      .populate('recipient', 'username')
      .sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Save a message
router.post('/', auth, async (req, res) => {
  try {
    const { recipientId, content } = req.body;

    const message = new Message({
      sender: req.user._id,
      recipient: recipientId,
      content
    });

    await message.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'username')
      .populate('recipient', 'username');

    res.status(201).json(populatedMessage);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;