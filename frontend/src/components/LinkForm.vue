<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    :title="isEdit ? '编辑链接' : '添加链接'"
    width="500px"
    @close="resetForm"
  >
    <el-alert
      v-if="isEdit && legacyIssues.length"
      type="warning"
      :closable="false"
      show-icon
      class="legacy-alert"
      title="该条目包含不符合当前规则的旧数据，可以查看，但需要修改后才能保存："
    >
      <ul class="legacy-list">
        <li v-for="(issue, i) in legacyIssues" :key="i">{{ issue }}</li>
      </ul>
    </el-alert>

    <el-form :model="form" :rules="rules" ref="formRef" label-width="80px">
      <el-form-item label="URL" prop="url">
        <el-input v-model="form.url" placeholder="https://example.com" />
      </el-form-item>

      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" placeholder="链接标题" />
      </el-form-item>

      <el-form-item label="描述" prop="description">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="3"
          placeholder="链接描述 (可选)"
        />
        <div class="field-hint" :class="{ over: descriptionLength > MAX_DESCRIPTION }">
          {{ descriptionLength }}/{{ MAX_DESCRIPTION }} 字
        </div>
      </el-form-item>

      <el-form-item label="分类">
        <el-select v-model="form.category_id" placeholder="选择分类" clearable style="width: 100%">
          <el-option
            v-for="cat in linksStore.categories"
            :key="cat.id"
            :label="cat.name"
            :value="cat.id"
          >
            <span>
              <el-tag :color="cat.color" effect="dark" size="small" style="margin-right: 8px">
                &nbsp;
              </el-tag>
              {{ cat.name }}
            </span>
          </el-option>
        </el-select>
      </el-form-item>

      <el-form-item label="标签" prop="tagsInput">
        <el-input v-model="form.tagsInput" placeholder="用逗号分隔多个标签，最多 10 个" />
        <div class="tag-hint">
          例如: 前端, Vue, 教程；每个标签不超过 20 个字，重复标签只保留一个
        </div>
      </el-form-item>

      <el-form-item label="稍后阅读">
        <el-checkbox v-model="form.is_read_later">加入稍后阅读清单</el-checkbox>
      </el-form-item>

      <el-form-item label="回顾日期" v-if="form.is_read_later">
        <el-date-picker
          v-model="form.review_date"
          type="date"
          placeholder="选择回顾日期（可选）"
          style="width: 100%"
          :disabled-date="disabledDate"
        />
        <div class="quick-dates">
          <el-button size="small" @click="setQuickDate(1)">明天</el-button>
          <el-button size="small" @click="setQuickDate(3)">3天后</el-button>
          <el-button size="small" @click="setQuickDate(7)">1周后</el-button>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { linksApi } from '../api'
import { useLinksStore } from '../stores/links'

const MAX_TAGS = 10
const MAX_TAG_LENGTH = 20
const MAX_DESCRIPTION = 300

const props = defineProps({
  visible: Boolean,
  link: Object,
})

const emit = defineEmits(['update:visible', 'saved', 'edit-existing'])

const linksStore = useLinksStore()
const formRef = ref(null)
const saving = ref(false)

const isEdit = computed(() => !!props.link?.id)

const form = reactive({
  url: '',
  title: '',
  description: '',
  category_id: null,
  tagsInput: '',
  is_read_later: false,
  review_date: null,
})

// Code-point based length, so each CJK character counts as one.
function charLength(value) {
  return Array.from(value || '').length
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}

// Split on ASCII or full-width commas, keeping positions for error indices.
function parseTagEntries() {
  return form.tagsInput.split(/[,，]/).map((t) => t.trim())
}

// Trim, drop empties, deduplicate (first occurrence wins).
function normalizedTags() {
  const seen = new Set()
  const result = []
  for (const tag of parseTagEntries()) {
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}

const validateUrl = (_rule, value, callback) => {
  const url = (value || '').trim()
  if (!url) return callback(new Error('请输入 URL'))
  if (!isValidHttpUrl(url)) {
    return callback(new Error('URL 只允许 http 或 https 协议'))
  }
  callback()
}

const validateTitle = (_rule, value, callback) => {
  if (!(value || '').trim()) return callback(new Error('请输入标题'))
  callback()
}

const validateDescription = (_rule, value, callback) => {
  if (charLength(value) > MAX_DESCRIPTION) {
    return callback(new Error(`描述最多 ${MAX_DESCRIPTION} 字，当前 ${charLength(value)} 字`))
  }
  callback()
}

const validateTags = (_rule, _value, callback) => {
  const entries = parseTagEntries()
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] && charLength(entries[i]) > MAX_TAG_LENGTH) {
      return callback(new Error(`第 ${i + 1} 个标签超过 ${MAX_TAG_LENGTH} 个字`))
    }
  }
  const tags = normalizedTags()
  if (tags.length > MAX_TAGS) {
    return callback(new Error(`标签最多 ${MAX_TAGS} 个，当前有 ${tags.length} 个`))
  }
  callback()
}

const rules = {
  url: [{ required: true, validator: validateUrl, trigger: 'blur' }],
  title: [{ required: true, validator: validateTitle, trigger: 'blur' }],
  description: [{ validator: validateDescription, trigger: 'blur' }],
  tagsInput: [{ validator: validateTags, trigger: 'blur' }],
}

const descriptionLength = computed(() => charLength(form.description))

// Problems in already-stored data: viewable, but not savable as-is.
const legacyIssues = computed(() => {
  if (!props.link) return []
  const issues = []
  if (!isValidHttpUrl((props.link.url || '').trim())) {
    issues.push('URL 不是合法的 http/https 地址')
  }
  if (charLength(props.link.description) > MAX_DESCRIPTION) {
    issues.push(`描述有 ${charLength(props.link.description)} 字，超过 ${MAX_DESCRIPTION} 字上限`)
  }
  const tags = props.link.tags || []
  const longIndex = tags.findIndex((t) => charLength(t) > MAX_TAG_LENGTH)
  if (longIndex !== -1) {
    issues.push(`第 ${longIndex + 1} 个标签超过 ${MAX_TAG_LENGTH} 个字`)
  }
  if (tags.length > MAX_TAGS) {
    issues.push(`标签有 ${tags.length} 个，超过 ${MAX_TAGS} 个上限`)
  }
  return issues
})

function fillForm(link) {
  form.url = link.url || ''
  form.title = link.title || ''
  form.description = link.description || ''
  form.category_id = link.category_id
  form.tagsInput = link.tags?.join(', ') || ''
  form.is_read_later = !!link.is_read_later
  form.review_date = link.review_date ? new Date(link.review_date) : null
  formRef.value?.clearValidate()
}

watch(
  () => props.visible,
  (val) => {
    if (val && props.link) {
      fillForm(props.link)
    } else if (val) {
      resetForm()
    }
  }
)

// Parent can swap to another link while the dialog stays open
// (e.g. after choosing "edit existing entry" on a duplicate URL).
watch(
  () => props.link,
  (link) => {
    if (props.visible && link) fillForm(link)
  }
)

function resetForm() {
  form.url = ''
  form.title = ''
  form.description = ''
  form.category_id = null
  form.tagsInput = ''
  form.is_read_later = false
  form.review_date = null
  formRef.value?.resetFields()
}

function disabledDate(time) {
  return time.getTime() < Date.now() - 86400000
}

function setQuickDate(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  form.review_date = date
}

// Offer to jump to editing the existing entry that owns the URL.
async function promptEditExisting(existing) {
  try {
    await ElMessageBox.confirm(
      `地址「${existing.url}」已存在于条目「${existing.title}」中，请改为编辑已有条目。`,
      '地址重复',
      {
        confirmButtonText: '编辑已有条目',
        cancelButtonText: '返回修改',
        type: 'warning',
      }
    )
    const { data } = await linksApi.getLink(existing.id)
    emit('edit-existing', data)
  } catch {
    // user chose to go back and fix the form
  }
}

async function handleSave() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  // Normalize before save: trim name/URL, merge duplicate tags.
  form.url = form.url.trim()
  form.title = form.title.trim()
  const tags = normalizedTags()

  saving.value = true
  try {
    // Pre-check duplicate before submitting.
    const check = await linksApi.checkUrl(form.url, isEdit.value ? props.link.id : null)
    if (check.data.duplicate && check.data.existing) {
      await promptEditExisting(check.data.existing)
      return
    }

    const data = {
      url: form.url,
      title: form.title,
      description: form.description,
      category_id: form.category_id,
      tags,
      is_read_later: form.is_read_later,
      review_date: form.review_date ? form.review_date.toISOString().split('T')[0] : null,
    }

    if (isEdit.value) {
      await linksApi.updateLink(props.link.id, data)
      ElMessage.success('更新成功')
    } else {
      await linksApi.createLink(data)
      ElMessage.success('添加成功')
    }

    emit('saved')
  } catch (err) {
    // Server is authoritative: honor its duplicate decision even if the
    // pre-check was skipped (e.g. request crafted outside the page).
    if (err.response?.status === 409 && err.response.data?.existing) {
      await promptEditExisting(err.response.data.existing)
    } else {
      ElMessage.error(err.response?.data?.error || '操作失败')
    }
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.legacy-alert {
  margin-bottom: 16px;
}

.legacy-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.tag-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.field-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  text-align: right;
  width: 100%;
}

.field-hint.over {
  color: #f56c6c;
}

.quick-dates {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
