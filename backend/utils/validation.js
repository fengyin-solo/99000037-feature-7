// Shared validation/normalization rules for link create/update.
// These rules are the server-side source of truth and mirror the
// constraints enforced by the frontend form, so bypassing the page
// (direct API calls) cannot persist invalid data.

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 300;
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

class ValidationError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
    this.extra = extra;
  }
}

// Length measured by code points so each CJK character counts as one.
function codePointLength(value) {
  return String(value).length;
}

// Parse a raw tags value (array from JSON, or a comma separated string)
// into trimmed entries, preserving original positions for error messages.
function parseTagEntries(tags) {
  let entries;
  if (Array.isArray(tags)) {
    entries = tags;
  } else if (typeof tags === 'string') {
    entries = tags.split(',');
  } else {
    return null;
  }
  return entries.map((tag) => (typeof tag === 'string' ? tag.trim() : String(tag).trim()));
}

// Trim, drop empties, validate per-tag length, deduplicate (first one wins)
// and cap the count. Returns { tags, errors }.
function normalizeTags(tags) {
  const errors = [];
  const entries = parseTagEntries(tags);
  if (entries === null) {
    return { tags: [], errors: ['标签必须是数组'] };
  }

  entries.forEach((tag, index) => {
    if (tag && codePointLength(tag) > MAX_TAG_LENGTH) {
      errors.push(`第 ${index + 1} 个标签超过 ${MAX_TAG_LENGTH} 个字`);
    }
  });

  const seen = new Set();
  const normalized = [];
  for (const tag of entries) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }

  if (normalized.length > MAX_TAGS) {
    errors.push(`标签最多 ${MAX_TAGS} 个，当前有 ${normalized.length} 个`);
  }

  return { tags: normalized.slice(0, MAX_TAGS), errors };
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.includes(parsed.protocol) && !!parsed.hostname;
}

// Validate and normalize a link payload.
// `current` is the existing row when updating; omitted fields keep their
// stored value (still re-validated as a whole), so legacy over-long data
// can be viewed but cannot be saved unchanged.
// Returns { value: { url, title, description, tags } , errors: [] }.
function sanitizeLinkPayload(body = {}, current = null) {
  const errors = [];

  const rawUrl = body.url !== undefined ? body.url : current?.url;
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) {
    errors.push('URL 不能为空');
  } else if (!isValidHttpUrl(url)) {
    errors.push('URL 只允许 http 或 https 协议，且必须是合法地址');
  }

  const rawTitle = body.title !== undefined ? body.title : current?.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title) {
    errors.push('标题不能为空');
  }

  const hasDescription = body.description !== undefined || !current;
  const rawDescription = body.description !== undefined ? body.description : current?.description;
  const description = typeof rawDescription === 'string' ? rawDescription : '';
  if (hasDescription && codePointLength(description) > MAX_DESCRIPTION_LENGTH) {
    errors.push(`描述最多 ${MAX_DESCRIPTION_LENGTH} 字，当前 ${codePointLength(description)} 字`);
  }

  let tags;
  if (body.tags !== undefined) {
    const result = normalizeTags(body.tags);
    tags = result.tags;
    errors.push(...result.errors);
  } else if (current?.tags) {
    // Tags were not submitted; keep the stored tags but still enforce
    // the new limits, otherwise an invalid legacy row could be re-saved.
    const result = normalizeTags(current.tags);
    tags = result.tags;
    errors.push(...result.errors);
  } else {
    tags = [];
  }

  return {
    value: { url, title, description, tags },
    errors,
  };
}

module.exports = {
  ValidationError,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  ALLOWED_PROTOCOLS,
  codePointLength,
  normalizeTags,
  isValidHttpUrl,
  sanitizeLinkPayload,
};
