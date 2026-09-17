const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db/init');
const { migrateDatabase } = require('./db/migrate');

const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const categoryRoutes = require('./routes/categories');
const importRoutes = require('./routes/import');
const healthCheckRoutes = require('./routes/health-check');

const app = express();
const PORT = 3004;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize and migrate database
initDatabase();
migrateDatabase();

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/import', importRoutes);
app.use('/api/health-check', healthCheckRoutes);

// Health check endpoint
app.get('/api/ping', (req, res) => {
  res.json({ message: 'Link Collector API is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`Link Collector API running on http://localhost:${PORT}`);
});
