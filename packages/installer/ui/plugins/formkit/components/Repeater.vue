<!-- ui/components/RepeaterInput.vue -->
<template>
  <div :class="context.classes.outer">
    <fieldset :class="context.classes.fieldset">
      <!-- existing items as “cards” -->
      <div>
        <div
          v-for="(item, index) in items"
          :key="index"
          :class="context.classes.item"
        >
          <div :class="context.classes.content">
            <div
              :class="[context.classes.innerLabel || '', 'text-sm font-medium']"
            >
              {{ summarizeItem(item, index) }}
            </div>
          </div>

          <ul :class="context.classes.controls">
            <li>
              <button
                type="button"
                :class="[context.classes.editIcon, context.classes.button]"
                aria-label="Edit"
                @click="startEdit(index)"
              >
                <FormKitIcon icon="edit" />
              </button>
            </li>
            <li>
              <button
                type="button"
                :class="[context.classes.removeIcon, context.classes.button]"
                aria-label="Remove"
                @click="removeItem(index)"
              >
                <FormKitIcon icon="trash" />
              </button>
            </li>
          </ul>
        </div>
        <div :class="context.classes.item" @click="startCreate">
          <button type="button" :class="context.classes.addButton">
            {{ context.addLabel || "Add" }}
            <FormKitIcon icon="add" :class="context.classes.addIcon" />
          </button>
        </div>
      </div>

      <!-- inner FormKit form for editing/creating a single item -->
      <div v-if="isEditing" :class="context.classes.content" class="relative">
        <template v-if="isEditing && editingIndex !== null">
          <div class="flex justify-between items-center mb-2">
            <label>
              Editing {{ summarizeItem(items[editingIndex], editingIndex) }}
            </label>
          </div>
          <hr class="mb-4" />
        </template>
        <button
          type="button"
          class="absolute top-3 end-3"
          :class="context.classes.closeIcon"
          @click="cancelEdit"
        >
          <FormKitIcon icon="close" />
        </button>
        <FormKit
          :key="editorKey"
          v-model="editingInitial"
          :items="items"
          :item-index="editingIndex"
          ignore
          :preserve="false"
          :parent="context.node"
          type="form"
          :incomplete-message="false"
          :actions="false"
          @submit="handleEditorSubmit"
        >
          <FormKitSchema
            :data="{ value: editingInitial }"
            :schema="itemSchema"
          />

          <div class="mt-3 flex justify-end gap-2">
            <button
              v-if="isEditing"
              type="button"
              class="text-xs text-neutral-600 hover:underline"
              @click="cancelEdit"
            >
              Cancel
            </button>
            <button
              type="submit"
              :class="
                sectionClasses(
                  'button',
                  'input',
                  'button',
                  context.classes.insertControl
                )
              "
            >
              Add
              <FormKitIcon icon="add" :class="context.classes.addIcon" />
            </button>
          </div>
        </FormKit>
      </div>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from "vue"
import {
  FormKit,
  FormKitSchema,
  FormKitMessages,
  useFormKitContext,
  FormKitIcon
} from "@formkit/vue"
import type {
  FormKitFrameworkContext,
  FormKitSchemaDefinition,
  FormKitNode
} from "@formkit/core"

const props = defineProps<{
  context: FormKitFrameworkContext
}>()

const context = props.context
const node = context.node

// main value
const items = ref<unknown[]>(
  Array.isArray((context as any)._value) ?
    [...((context as any)._value as any[])]
  : []
)

// schema for a single item
const itemSchema = computed<FormKitSchemaDefinition>(() => {
  return (
    (context as any).itemSchema ??
    (node.props && (node.props as any).itemSchema)
  )
})

// editor state
type EditMode = "create" | "edit" | null

const editMode = ref<EditMode>(null)
const editingIndex = ref<number | null>(null)
const editingInitial = ref<Record<string, unknown>>({})
const editorKey = ref(0)

const hasItems = computed(() => items.value.length > 0)
const isEditing = computed(() => editMode.value !== null)

function beginEditor(mode: EditMode, index: number | null) {
  editorKey.value += 1
  editMode.value = mode
  editingIndex.value = index

  if (mode === "edit" && index !== null) {
    const current = items.value[index]
    editingInitial.value =
      current && typeof current === "object" ? { ...(current as any) } : {}
  } else {
    editingInitial.value = {}
  }
}

function startCreate() {
  beginEditor("create", null)
}

function startEdit(index: number) {
  beginEditor("edit", index)
}

function cancelEdit() {
  editMode.value = null
  editingIndex.value = null
  editingInitial.value = {}
}

// auto-open editor when there is no item yet
onMounted(() => {
  if (!hasItems.value) {
    startCreate()
  }
})

function handleEditorSubmit(
  values: Record<string, unknown>,
  formNode?: FormKitNode
) {
  const next = items.value.slice()

  if (editMode.value === "create" || editingIndex.value === null) {
    next.push(values)
  } else {
    next[editingIndex.value] = values
  }

  node.input([...next])
  items.value = [...next]

  formNode?.reset()
  cancelEdit()
}

function removeItem(index: number) {
  const next = items.value.slice()
  next.splice(index, 1)
  node.input([...next])
  items.value = next

  if (editingIndex.value === index) {
    cancelEdit()
  } else if (
    editingIndex.value !== null &&
    editingIndex.value > index &&
    editingIndex.value > 0
  ) {
    editingIndex.value = editingIndex.value - 1
  }
}

function summarizeItem(item: any, index: number): string {
  if (!item || typeof item !== "object") return `Item #${index + 1}`

  return node.props.itemSummary?.(item, index) ?? `Item #${index + 1}`
}

const sectionClasses =
  node.config.rootConfig?.sectionClasses || ((...args: any) => ({}))
</script>
