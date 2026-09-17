// 与后端 backend/utils/validation.js 保持一致的表单规则（前端即时反馈用，
// 真正的强制校验在服务端完成）。

export const MAX_TAG_COUNT = 10
export const MAX_TAG_LENGTH = 20
export const MAX_DESCRIPTION_LENGTH = 300

// 按 Unicode 码点计数，避免中文/emoji 被代理对重复计数
export function codePointLength(str) {
  return Array.from(str).length
}

// 标签输入统一按英文/中文逗号拆分
export function parseRawTags(input) {
  return (input || '')
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter((t) => t)
}

// 返回 { error } 或 { tags: 去重后的标签列表 }
export function validateTags(input) {
  const list = parseRawTags(input)

  for (let i = 0; i < list.length; i += 1) {
    if (codePointLength(list[i]) > MAX_TAG_LENGTH) {
      return { error: `第 ${i + 1} 个标签超过 ${MAX_TAG_LENGTH} 个字` }
    }
  }

  // 同一批输入里重复的标签只保留第一个
  const seen = new Set()
  const tags = []
  for (const tag of list) {
    if (!seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }

  if (tags.length > MAX_TAG_COUNT) {
    return { error: `标签最多 ${MAX_TAG_COUNT} 个（当前 ${tags.length} 个）` }
  }

  return { tags }
}

// 仅允许 http/https 协议的地址
export function isValidHttpUrl(value) {
  const url = (value || '').trim()
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}
