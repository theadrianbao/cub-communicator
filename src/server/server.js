require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Identifies user to socketId
const socketUsers = new Map();

app.use(cors());
app.use(bodyParser.json());

// Gives jwt token from new user's username and publicKey
app.post('/api/auth', async (req, res) => {
  const { username, publicKey } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required.' });

  let existingUser = await db.query('SELECT * FROM users WHERE username = $1', [username]);

  if (existingUser.rows.length === 0) {
    if (!publicKey) {
      return res.status(400).json({ error: 'PublicKey is required for new user registration.' });
    }
    await db.query('INSERT INTO users (username, public_key) VALUES ($1, $2)', [username, publicKey]);
  } else if (publicKey) {
    await db.query('UPDATE users SET public_key = $1 WHERE username = $2', [publicKey, username]);
  }

  const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// Middleware that verifies jwt
app.use((req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Retrieves conversation partners of user
app.get('/api/contacts', async (req, res) => {
  const { username } = req.user;
  const query = `
    SELECT u.username, u.public_key
    FROM users u
    JOIN contacts c ON u.id = c.contact_id
    WHERE c.user_id = (SELECT id FROM users WHERE username = $1)
  `;
  const result = await db.query(query, [username]);
  res.json(result.rows);
});

// Retrieves users' messages
app.get('/api/messages', async (req, res) => {
  const { username } = req.user;
  const withUser = req.query.with;

  const query = `
    SELECT
      sender.username AS from,
      recipient.username AS to,
      m.ciphertext,
      m.nonce,
      m.created_at
    FROM messages m
    JOIN users sender ON m.sender_id = sender.id
    JOIN users recipient ON m.recipient_id = recipient.id
    WHERE (sender.username = $1 AND recipient.username = $2)
       OR (sender.username = $2 AND recipient.username = $1)
    ORDER BY m.created_at ASC
  `;
  const result = await db.query(query, [username, withUser]);
  res.json(result.rows);
});

// Associates public key with user
app.post('/api/publickeys', async (req, res) => {
  const { publicKey } = req.body;
  const { username } = req.user;
  await db.query('UPDATE users SET public_key = $1 WHERE username = $2', [publicKey, username]);
  res.sendStatus(200);
});

// Retrieves public key for username
app.post('/api/getpublickey', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username parameter is required.' });
  }

  try {
    const result = await db.query('SELECT public_key FROM users WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      res.json({ publicKey: result.rows[0].public_key });
    } else {
      res.status(404).json({ error: `User "${username}" not found.` });
    }
  } catch (error) {
    console.error('Error fetching public key:', error);
    res.status(500).json({ error: 'Failed to retrieve public key.' });
  }
});

// Adds contact to user
app.post('/api/contacts/add', async (req, res) => {
  const { username } = req.user;
  const { contactUsername } = req.body;

  const userResult = await db.query('SELECT id FROM users WHERE username = $1', [username]);
  const contactResult = await db.query('SELECT id FROM users WHERE username = $1', [contactUsername]);

  if (userResult.rows.length === 0 || contactResult.rows.length === 0) {
    return res.status(404).json({ error: 'User or contact not found.' });
  }

  const userId = userResult.rows[0].id;
  const contactId = contactResult.rows[0].id;

  const existing = await db.query('SELECT * FROM contacts WHERE user_id = $1 AND contact_id = $2', [userId, contactId]);
  if (existing.rows.length === 0) {
    await db.query('INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2)', [userId, contactId]);
  }

  res.sendStatus(200);
});

// Authenticates JWT attached to websocket messages
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error: No token"));

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = user;
    next();
  } catch (err) {
    return next(new Error("Authentication error: Invalid token"));
  }
});

// Saves message and contact data
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.user.username);
  socketUsers.set(socket.user.username, socket.id);

  socket.on('message:send', async ({ to, ciphertext, nonce }) => {
    const from = socket.user.username;

    const sender = await db.query('SELECT id FROM users WHERE username = $1', [from]);
    const recipient = await db.query('SELECT id FROM users WHERE username = $1', [to]);

    if (!recipient.rows.length) return;

    await db.query(`
      INSERT INTO messages (sender_id, recipient_id, ciphertext, nonce)
      VALUES ($1, $2, $3, $4)
    `, [sender.rows[0].id, recipient.rows[0].id, ciphertext, nonce]);

    await ensureContact(sender.rows[0].id, recipient.rows[0].id);
    await ensureContact(recipient.rows[0].id, sender.rows[0].id);

    const recipientSocketId = socketUsers.get(to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message:receive', { from, ciphertext, nonce });
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.user.username);
    socketUsers.delete(socket.user.username);
  });
});

// Adds contact data
async function ensureContact(userId, contactId) {
  const exists = await db.query('SELECT 1 FROM contacts WHERE user_id = $1 AND contact_id = $2', [userId, contactId]);
  if (exists.rows.length === 0) {
    await db.query('INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2)', [userId, contactId]);
  }
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
