const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { generateToken } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Email transporter configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Function to send verification email
async function sendVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  user.verificationToken = token;
  user.verificationExpires = expires;
  await user.save();

  const verifyUrl = `${BASE_URL}/api/auth/verify/${token}`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: 'Verify your ChatApp account',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; background-color: #0f172a; color: #fff; padding: 20px; }
          .container { max-width: 500px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 10px; }
          .btn { display: inline-block; background: #6366f1; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Welcome to ChatApp!</h2>
          <p>Please verify your email address to get started.</p>
          <a href="${verifyUrl}" class="btn">Verify Email</a>
          <p style="margin-top: 20px; color: #94a3b8; font-size: 12px;">Or copy this link: ${verifyUrl}</p>
        </div>
      </body>
      </html>
    `
  };

  // For development: log the verification link
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log(`\n=== EMAIL VERIFICATION (dev mode) ===`);
    console.log(`Verify email: ${verifyUrl}`);
    console.log(`To enable real emails, set EMAIL_USER and EMAIL_PASS in .env`);
    console.log(`====================================\n`);
    return;
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent to: ${user.email}`);
  } catch (error) {
    console.log('Email send error:', error.message);
    console.log('Make sure EMAIL_USER and EMAIL_PASS are correct in .env file');
    console.log('For Gmail, use an App Password: https://support.google.com/accounts/answer/185833');
    // Still log for development
    console.log(`\n=== EMAIL VERIFICATION (fallback) ===`);
    console.log(`Verify email: ${verifyUrl}`);
    console.log(`====================================\n`);
  }
}

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      return res.status(400).json({
        message: existingUser.email === email
          ? 'Email already registered'
          : 'Username already taken'
      });
    }

    // Create new user (not verified)
    const user = new User({
      username,
      email,
      password,
      isVerified: false
    });

    // Generate verification token
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    user.verificationToken = token;
    user.verificationExpires = expires;

    await user.save();

    // Send verification email
    await sendVerificationEmail(user);

    res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account.',
      // Don't return token until verified
      requiresVerification: true,
      user: user.toJSON()
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check if email is verified
    if (!user.isVerified) {
      return res.status(400).json({
        message: 'Please verify your email before logging in. Check your inbox for the verification link.'
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = generateToken(user._id);

    res.json({
      message: 'Login successful',
      token,
      user: user.toJSON()
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Resend verification email
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: 'Email is already verified' });
    }

    await sendVerificationEmail(user);

    res.json({ message: 'Verification email sent. Please check your inbox.' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;