const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { validateLinkInput } = require('../utils/validation');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// 组装一条链接记录（含标签与分类信息），供各接口复用
function serializeLink(db, id) {
  const link = db.prepare(`
    SELECT l.*, c.name as category_name, c.color as category_color
    FROM links l
    LEFT JOIN categories c ON l.category_id = c.id
    WHERE l.id = ?
  `).get(id);

  if (!link) return null;

  const linkTags = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?').all(id);
  return {
    ...link,
    tags: linkTags.map((t) => t.tag),
  };
}

// 同一用户下地址不能重复；编辑时 excludeId 为当前链接 id
function findDuplicateUrl(db, userId, url, excludeId = null) {
  const row = db
    .prepare('SELECT id FROM links WHERE user_id = ? AND url = ? AND id != ? LIMIT 1')
    .get(userId, url, excludeId || 0);
  return row ? row.id : null;
}

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

// GET /api/links/exists?url=...&excludeId=... - 保存前检查地址是否已收藏
router.get('/exists', (req, res) => {
  const userId = req.userId;
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';

  if (!rawUrl) {
    return res.status(400).json({ error: 'URL 不能为空' });
  }

  const excludeId = Number(req.query.excludeId) || null;

  const db = getDb();
  const duplicateId = findDuplicateUrl(db, userId, rawUrl, excludeId);
  if (!duplicateId) {
    return res.json({ exists: false });
  }

  const link = serializeLink(db, duplicateId);
  return res.status(409).json({
    exists: true,
    error: '该地址已收藏，请改为编辑已有条目',
    code: 'DUPLICATE_URL',
    link,
  });
});

// POST /api/links - Create a new link
router.post('/', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const { category_id, is_read_later, review_date } = req.body || {};

  // 服务端强制校验：协议、长度、标签数量、重复标签等
  const result = validateLinkInput(req.body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const { url, title, description, tags } = result.data;

  // 地址重复时不允许创建，引导改为编辑已有条目
  const duplicateId = findDuplicateUrl(db, userId, url);
  if (duplicateId) {
    return res.status(409).json({
      error: '该地址已收藏，请改为编辑已有条目',
      code: 'DUPLICATE_URL',
      link: serializeLink(db, duplicateId),
    });
  }

  const insertResult = db.prepare(
    'INSERT INTO links (user_id, url, title, description, category_id, status, is_read_later, review_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, url, title, description, category_id || null, 'unchecked', is_read_later ? 1 : 0, review_date || null);

  const linkId = insertResult.lastInsertRowid;

  // Insert tags（校验已去重、限量，这里按结果直接写入）
  if (tags.length > 0) {
    const insertTag = db.prepare('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)');
    const insertTags = db.transaction((tagList) => {
      tagList.forEach((tag) => insertTag.run(linkId, tag));
    });
    insertTags(tags);
  }

  res.status(201).json(serializeLink(db, linkId));
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

// PUT /api/links/:id - Update a link
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const { category_id, is_read_later, review_date, review_status } = body;
  const userId = req.userId;

  const db = getDb();

  // Verify ownership
  const link = db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?').get(id, userId);
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }

  const tagsProvided = body.tags !== undefined && body.tags !== null;
  const contentFieldsProvided =
    body.url !== undefined ||
    body.title !== undefined ||
    body.description !== undefined ||
    tagsProvided;

  let url = link.url;
  let title = link.title;
  let description = link.description;
  let tags;

  // 只有提交了内容字段（完整表单一定会全部提交）才走强制校验。
  // 与存量值合并后一起校验：已存在的超长/非法数据不能原样保存。
  if (contentFieldsProvided) {
    const existingTags = db
      .prepare('SELECT tag FROM link_tags WHERE link_id = ?')
      .all(id)
      .map((t) => t.tag);

    const candidate = {
      url: body.url !== undefined ? body.url : link.url,
      title: body.title !== undefined ? body.title : link.title,
      description: body.description !== undefined ? body.description : link.description,
      tags: tagsProvided ? body.tags : existingTags,
    };

    const result = validateLinkInput(candidate);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    url = result.data.url;
    title = result.data.title;
    description = result.data.description;
    tags = result.data.tags;
  }

  // 地址重复（指向其他条目）时拒绝保存
  if (body.url !== undefined) {
    const duplicateId = findDuplicateUrl(db, userId, url, id);
    if (duplicateId) {
      return res.status(409).json({
        error: '该地址已被其他条目使用，请改为编辑已有条目',
        code: 'DUPLICATE_URL',
        link: serializeLink(db, duplicateId),
      });
    }
  }

  // Update link
  db.prepare(`
    UPDATE links
    SET url = ?, title = ?, description = ?, category_id = ?, is_read_later = ?, review_date = ?, review_status = ?
    WHERE id = ?
  `).run(
    url,
    title,
    description ?? '',
    category_id !== undefined && category_id !== null ? category_id : link.category_id,
    is_read_later !== undefined ? (is_read_later ? 1 : 0) : link.is_read_later,
    review_date !== undefined ? review_date : link.review_date,
    review_status || link.review_status,
    id
  );

  // 仅在提交了 tags 时重写标签（校验已去重、限量）
  if (contentFieldsProvided && tagsProvided) {
    db.prepare('DELETE FROM link_tags WHERE link_id = ?').run(id);
    if (tags.length > 0) {
      const insertTag = db.prepare('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)');
      const insertTags = db.transaction((tagList) => {
        tagList.forEach((tag) => insertTag.run(id, tag));
      });
      insertTags(tags);
    }
  }

  res.json(serializeLink(db, id));
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
