const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeLinkPayload, isValidHttpUrl } = require('../utils/validation');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

function sendValidationErrors(res, errors, status = 400, extra = {}) {
  return res.status(status).json({ error: errors.join('；'), errors, ...extra });
}

// Attach the user's stored tags to a link row
function withTags(db, link) {
  const linkTags = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?').all(link.id);
  return { ...link, tags: linkTags.map((t) => t.tag) };
}

// Find another link (same user) with the same URL.
// Comparison ignores leading/trailing whitespace because URLs are trimmed.
function findDuplicateUrl(db, userId, url, excludeId = null) {
  const sql = 'SELECT id, url, title FROM links WHERE user_id = ? AND url = ?'
    + (excludeId !== null ? ' AND id != ?' : '');
  const params = excludeId !== null ? [userId, url, excludeId] : [userId, url];
  return db.prepare(sql).get(...params);
}

// GET /api/links/check-url?url=...&exclude_id=... - Duplicate URL pre-check
router.get('/check-url', (req, res) => {
  const userId = req.userId;
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';

  if (!isValidHttpUrl(url)) {
    return sendValidationErrors(res, ['URL 只允许 http 或 https 协议，且必须是合法地址']);
  }

  const db = getDb();
  const existing = findDuplicateUrl(db, userId, url, req.query.exclude_id || null);
  res.json({ duplicate: !!existing, existing: existing || null });
});

// GET /api/links - List links with pagination, filtering, search
router.get('/', (req, res) => {
  const { page = 1, limit = 12, category, tag, search } = req.query;
  const offset = (page - 1) * limit;
  const userId = req.userId;

  const db = getDb();

  let whereConditions = ['l.user_id = ?'];
  let params = [userId];

  if (category) {
    whereConditions.push('l.category_id = ?');
    params.push(category);
  }

  if (search) {
    whereConditions.push('(l.title LIKE ? OR l.description LIKE ? OR l.url LIKE ?)');
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  let joinClause = '';
  if (tag) {
    joinClause = 'INNER JOIN link_tags lt ON l.id = lt.link_id';
    whereConditions.push('lt.tag = ?');
    params.push(tag);
  }

  const whereClause = whereConditions.join(' AND ');

  // Get total count
  const countSql = `SELECT COUNT(DISTINCT l.id) as total FROM links l ${joinClause} WHERE ${whereClause}`;
  const { total } = db.prepare(countSql).get(...params);

  // Get links
  const sql = `
    SELECT DISTINCT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    ${joinClause}
    WHERE ${whereClause}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const links = db.prepare(sql).all(...params, Number(limit), Number(offset));

  // Get tags for each link
  const getTagsStmt = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?');
  const linksWithTags = links.map((link) => ({
    ...link,
    tags: getTagsStmt.all(link.id).map((t) => t.tag),
  }));

  res.json({
    links: linksWithTags,
    total,
    page: Number(page),
    totalPages: Math.ceil(total / limit),
  });
});

// POST /api/links - Create a new link
router.post('/', (req, res) => {
  const userId = req.userId;
  const body = req.body || {};
  const { category_id, is_read_later, review_date } = body;

  const { value, errors } = sanitizeLinkPayload(body);
  if (errors.length > 0) {
    return sendValidationErrors(res, errors);
  }

  const db = getDb();

  // Duplicate URLs are rejected before saving; the client offers to
  // edit the existing entry instead.
  const existing = findDuplicateUrl(db, userId, value.url);
  if (existing) {
    return sendValidationErrors(res, ['该地址已存在，请直接编辑已有条目'], 409, { existing });
  }

  const result = db.prepare(
    'INSERT INTO links (user_id, url, title, description, category_id, status, is_read_later, review_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, value.url, value.title, value.description, category_id || null, 'unchecked', is_read_later ? 1 : 0, review_date || null);

  const linkId = result.lastInsertRowid;

  // Insert normalized tags (already trimmed and deduplicated)
  if (value.tags.length > 0) {
    const insertTag = db.prepare('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)');
    const insertTags = db.transaction((tagList) => {
      tagList.forEach((tag) => insertTag.run(linkId, tag));
    });
    insertTags(value.tags);
  }

  // Fetch the created link with all data
  const link = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.id = ?
  `).get(linkId);

  res.json(withTags(db, link));
});

// GET /api/links/read-later - Get read later list with filtering
// NOTE: This must come BEFORE /:id routes to avoid being matched as an id
router.get('/read-later', (req, res) => {
  const { page = 1, limit = 12, status = 'pending' } = req.query;
  const offset = (page - 1) * limit;
  const userId = req.userId;

  const db = getDb();

  const validStatuses = ['pending', 'completed', 'skipped', 'all'];
  const filterStatus = validStatuses.includes(status) ? status : 'pending';

  let whereConditions = ['l.user_id = ?', 'l.is_read_later = 1'];
  let params = [userId];

  if (filterStatus !== 'all') {
    whereConditions.push('l.review_status = ?');
    params.push(filterStatus);
  }

  const whereClause = whereConditions.join(' AND ');

  // Get total count
  const countSql = `SELECT COUNT(*) as total FROM links l WHERE ${whereClause}`;
  const { total } = db.prepare(countSql).get(...params);

  // Get read later links
  const sql = `
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE ${whereClause}
    ORDER BY 
      CASE l.review_status 
        WHEN 'pending' THEN 1 
        WHEN 'completed' THEN 2 
        ELSE 3 
      END,
      l.review_date IS NULL,
      l.review_date ASC,
      l.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const links = db.prepare(sql).all(...params, Number(limit), Number(offset));

  // Get tags for each link
  const getTagsStmt = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?');
  const linksWithTags = links.map((link) => ({
    ...link,
    tags: getTagsStmt.all(link.id).map((t) => t.tag),
  }));

  // Get statistics
  const statsSql = `
    SELECT 
      review_status,
      COUNT(*) as count
    FROM links
    WHERE user_id = ? AND is_read_later = 1
    GROUP BY review_status
  `;
  const statsResult = db.prepare(statsSql).all(userId);
  const stats = {
    pending: 0,
    completed: 0,
    skipped: 0,
    total: 0
  };
  statsResult.forEach(s => {
    stats[s.review_status] = s.count;
    stats.total += s.count;
  });

  res.json({
    links: linksWithTags,
    total,
    page: Number(page),
    totalPages: Math.ceil(total / limit),
    stats
  });
});

// POST /api/links/:id/read-later - Add link to read later
router.post('/:id/read-later', (req, res) => {
  const { id } = req.params;
  const { review_date } = req.body;
  const userId = req.userId;

  const db = getDb();

  // Verify ownership
  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  db.prepare(`
    UPDATE links
    SET is_read_later = 1, review_date = ?, review_status = 'pending'
    WHERE id = ?
  `).run(review_date || null, id);

  // Fetch updated link
  const updatedLink = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.id = ?
  `).get(id);

  const linkTags = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?').all(id);

  res.json({
    ...updatedLink,
    tags: linkTags.map((t) => t.tag),
  });
});

// DELETE /api/links/:id/read-later - Remove link from read later
router.delete('/:id/read-later', (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const db = getDb();

  // Verify ownership
  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  db.prepare(`
    UPDATE links
    SET is_read_later = 0, review_date = NULL, review_status = 'pending'
    WHERE id = ?
  `).run(id);

  res.json({ message: 'Removed from read later list' });
});

// PUT /api/links/:id/review-status - Update review status
router.put('/:id/review-status', (req, res) => {
  const { id } = req.params;
  const { review_status } = req.body;
  const userId = req.userId;

  const db = getDb();

  // Verify ownership
  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  const validStatuses = ['pending', 'completed', 'skipped'];
  if (!validStatuses.includes(review_status)) {
    return res.status(400).json({ error: 'Invalid review status' });
  }

  db.prepare(`
    UPDATE links
    SET review_status = ?
    WHERE id = ?
  `).run(review_status, id);

  // Fetch updated link
  const updatedLink = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.id = ?
  `).get(id);

  const linkTags = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?').all(id);

  res.json({
    ...updatedLink,
    tags: linkTags.map((t) => t.tag),
  });
});

// GET /api/links/:id - Get a single link (used when switching to edit
// an existing entry found via the duplicate URL check)
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const db = getDb();

  const link = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.id = ? AND l.user_id = ?
  `).get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  res.json(withTags(db, link));
});

// PUT /api/links/:id - Update a link
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const userId = req.userId;

  const db = getDb();

  // Verify ownership
  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  // Stored tags are merged in for validation of untouched fields
  const storedTags = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?').all(id).map((t) => t.tag);
  const current = { ...link, tags: storedTags };

  const { value, errors } = sanitizeLinkPayload(body, current);
  if (errors.length > 0) {
    return sendValidationErrors(res, errors);
  }

  const { category_id, is_read_later, review_date, review_status } = body;

  // Reject if another entry of this user already uses the same URL
  const existing = findDuplicateUrl(db, userId, value.url, id);
  if (existing) {
    return sendValidationErrors(res, ['该地址已被其他条目使用，请直接编辑已有条目'], 409, { existing });
  }

  // Update link
  db.prepare(`
    UPDATE links
    SET url = ?, title = ?, description = ?, category_id = ?, is_read_later = ?, review_date = ?, review_status = ?
    WHERE id = ?
  `).run(
    value.url,
    value.title,
    value.description,
    category_id !== undefined ? (category_id || null) : link.category_id,
    is_read_later !== undefined ? (is_read_later ? 1 : 0) : link.is_read_later,
    review_date !== undefined ? review_date : link.review_date,
    review_status || link.review_status,
    id
  );

  // Replace tags with the normalized set when tags were submitted;
  // otherwise the stored tags were only used for re-validation
  if (body.tags !== undefined) {
    const replaceTags = db.transaction((tagList) => {
      db.prepare('DELETE FROM link_tags WHERE link_id = ?').run(id);
      const insertTag = db.prepare('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)');
      tagList.forEach((tag) => insertTag.run(id, tag));
    });
    replaceTags(value.tags);
  }

  // Fetch updated link
  const updatedLink = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.id = ?
  `).get(id);

  res.json(withTags(db, updatedLink));
});

// DELETE /api/links/:id - Delete a link
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const db = getDb();

  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  db.prepare('DELETE FROM link_tags WHERE link_id = ?').run(id);
  db.prepare('DELETE FROM links WHERE id = ?').run(id);

  res.json({ message: 'Link deleted successfully' });
});

module.exports = router;
