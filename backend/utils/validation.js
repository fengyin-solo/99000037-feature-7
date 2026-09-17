// 链接表单的统一校验与规范化规则。
// routes/links.js 在创建/更新时强制执行，绕过页面直接提交同样会被拒绝。

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_TAG_COUNT = 10;
const MAX_TAG_LENGTH = 20; // 单个标签最多 20 个字
const MAX_DESCRIPTION_LENGTH = 300; // 描述最多 300 个字

// 按 Unicode 码点计数，避免中文/emoji 被代理对重复计数
function codePointLength(str) {
  return Array.from(str).length;
}

// 标签入参支持数组（页面正常提交）或逗号分隔字符串（绕过页面提交时）。
// 返回 { tags } 或 { error }。
function normalizeTags(input) {
  let rawList;
  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === 'string') {
    rawList = input.split(/[,，]/);
  } else {
    return { error: '标签格式不正确' };
  }

  // 去掉每个标签前后的空格并丢弃空标签
  const list = [];
  for (const item of rawList) {
    if (typeof item !== 'string') {
      return { error: '标签格式不正确' };
    }
    const tag = item.trim();
    if (tag) list.push(tag);
  }

  // 先按位置检查长度，便于指出是第几个标签超了
  for (let i = 0; i < list.length; i += 1) {
    if (codePointLength(list[i]) > MAX_TAG_LENGTH) {
      return { error: `第 ${i + 1} 个标签超过 ${MAX_TAG_LENGTH} 个字` };
    }
  }

  // 同一批输入里重复的标签只保留第一个
  const seen = new Set();
  const tags = [];
  for (const tag of list) {
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }

  if (tags.length > MAX_TAG_COUNT) {
    return { error: `标签最多 ${MAX_TAG_COUNT} 个（当前 ${tags.length} 个）` };
  }

  return { tags };
}

// 校验并规范化一份链接表单数据。
// 返回 { data: { url, title, description, tags } } 或 { error }。
function validateLinkInput(body) {
  const data = body || {};

  if (typeof data.url !== 'string') {
    return { error: 'URL 不能为空' };
  }
  const url = data.url.trim();
  if (!url) {
    return { error: 'URL 不能为空' };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: 'URL 格式不正确，仅支持 http 或 https 协议' };
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsedUrl.protocol) || !parsedUrl.hostname) {
    return { error: '仅支持 http 或 https 协议的地址' };
  }

  if (typeof data.title !== 'string') {
    return { error: '标题不能为空' };
  }
  const title = data.title.trim();
  if (!title) {
    return { error: '标题不能为空' };
  }

  let description = '';
  if (data.description !== undefined && data.description !== null) {
    if (typeof data.description !== 'string') {
      return { error: '描述必须是文本' };
    }
    if (codePointLength(data.description) > MAX_DESCRIPTION_LENGTH) {
      return {
        error: `描述最多 ${MAX_DESCRIPTION_LENGTH} 字（当前 ${codePointLength(data.description)} 字）`,
      };
    }
    description = data.description;
  }

  let tags = [];
  if (data.tags !== undefined && data.tags !== null) {
    const tagResult = normalizeTags(data.tags);
    if (tagResult.error) {
      return { error: tagResult.error };
    }
    tags = tagResult.tags;
  }

  return { data: { url, title, description, tags } };
}

module.exports = {
  ALLOWED_URL_PROTOCOLS,
  MAX_TAG_COUNT,
  MAX_TAG_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  codePointLength,
  normalizeTags,
  validateLinkInput,
};
