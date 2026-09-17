<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    :title="isEdit ? '编辑链接' : '添加链接'"
    width="500px"
    @close="resetForm"
  >
    <el-form :model="form" :rules="rules" ref="formRef" label-width="80px">
      <el-form-item label="URL" prop="url">
        <el-input v-model="form.url" placeholder="https://example.com" />
        <div class="field-hint">仅支持 http 或 https 协议的地址</div>
      </el-form-item>

      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" placeholder="链接标题" />
      </el-form-item>

      <el-form-item label="描述" prop="description">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="3"
          maxlength="300"
          show-word-limit
          placeholder="链接描述 (可选)"
        />
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
        <el-input v-model="form.tagsInput" placeholder="用逗号分隔多个标签" />
        <div class="field-hint">最多 10 个标签，每个不超过 20 字，重复标签只保留一个</div>
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
import { ref, reactive, watch, computed, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useLinksStore } from '../stores/links'
import { linksApi } from '../api'
import {
  codePointLength,
  validateTags,
  isValidHttpUrl,
  MAX_DESCRIPTION_LENGTH,
} from '../utils/validation'

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

function validateUrl(rule, value, callback) {
  const url = (value || '').trim()
  if (!url) {
    callback(new Error('请输入 URL'))
  } else if (!isValidHttpUrl(url)) {
    callback(new Error('仅支持 http 或 https 协议的有效地址'))
  } else {
    callback()
  }
}

function validateTitle(rule, value, callback) {
  if (!(value || '').trim()) {
    callback(new Error('请输入标题'))
  } else {
    callback()
  }
}

function validateDescription(rule, value, callback) {
  if (value && codePointLength(value) > MAX_DESCRIPTION_LENGTH) {
    callback(new Error(`描述最多 ${MAX_DESCRIPTION_LENGTH} 字（当前 ${codePointLength(value)} 字）`))
  } else {
    callback()
  }
}

function validateTagsField(rule, value, callback) {
  const result = validateTags(value)
  if (result.error) {
    callback(new Error(result.error))
  } else {
    callback()
  }
}

const rules = {
  url: [{ validator: validateUrl, trigger: 'blur' }],
  title: [{ validator: validateTitle, trigger: 'blur' }],
  description: [{ validator: validateDescription, trigger: 'blur' }],
  tagsInput: [{ validator: validateTagsField, trigger: 'blur' }],
}

watch(
  () => props.visible,
  (val) => {
    if (val) {
      populateForm()
    } else {
      resetForm()
    }
  }
)

// 地址重复确认后，父组件会把 link 换成已有条目，弹窗保持打开并载入其内容
watch(
  () => props.link?.id,
  () => {
    if (props.visible) {
      populateForm()
    }
  }
)

function populateForm() {
  if (props.link) {
    form.url = props.link.url
    form.title = props.link.title
    form.description = props.link.description || ''
    form.category_id = props.link.category_id
    form.tagsInput = props.link.tags?.join(', ') || ''
    form.is_read_later = props.link.is_read_later || false
    form.review_date = props.link.review_date ? new Date(props.link.review_date) : null
  } else {
    resetForm()
  }
  nextTick(() => formRef.value?.clearValidate())
}

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

// 地址重复时，提示并引导改为编辑已有条目
async function promptDuplicate(existing, message) {
  if (!existing?.id) {
    ElMessage.error(message || '该地址已存在')
    return
  }
  try {
    await ElMessageBox.confirm(
      `「${existing.title}」已经使用了这个地址。${message}，是否改为编辑该条目？`,
      '地址重复',
      {
        confirmButtonText: '编辑已有条目',
        cancelButtonText: '留在本页',
        type: 'warning',
      }
    )
    emit('edit-existing', existing)
  } catch {
    // 用户取消，留在当前表单继续修改
  }
}

async function handleSave() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  // 名称和地址去掉前后空格后再保存；重复标签在 validateTags 内已只保留一个
  const url = form.url.trim()
  const title = form.title.trim()
  form.url = url
  form.title = title

  const tagResult = validateTags(form.tagsInput)
  if (tagResult.error) {
    ElMessage.error(tagResult.error)
    return
  }
  const tags = tagResult.tags

  saving.value = true
  try {
    // 保存前先检查地址是否已收藏（服务端保存时还会再强制检查一次）
    try {
      await linksApi.checkUrlExists(url, isEdit.value ? props.link.id : null)
    } catch (preErr) {
      if (preErr.response?.status === 409 && preErr.response.data?.code === 'DUPLICATE_URL') {
        await promptDuplicate(preErr.response.data.link, preErr.response.data.error)
        return
      }
      // 预检服务异常时不阻塞，由保存接口做最终校验
    }

    const data = {
      url,
      title,
      description: form.description,
      category_id: form.category_id,
      tags,
      is_read_later: form.is_read_later,
      review_date: form.review_date ? form.review_date.toISOString().split('T')[0] : null,
    }

    if (isEdit.value) {
      await linksStore.updateLink(props.link.id, data)
      ElMessage.success('更新成功')
    } else {
      await linksStore.createLink(data)
      ElMessage.success('添加成功')
    }

    emit('saved')
  } catch (err) {
    if (err.response?.status === 409 && err.response.data?.code === 'DUPLICATE_URL') {
      await promptDuplicate(err.response.data.link, err.response.data.error)
    } else {
      ElMessage.error(err.response?.data?.error || '操作失败')
    }
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.field-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  line-height: 1.4;
}

.quick-dates {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
