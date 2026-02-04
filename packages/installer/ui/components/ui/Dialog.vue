<!-- Dialog.vue -->
<template>
  <!-- Backdrop -->
  <div
    v-if="visible"
    class="fixed inset-0 z-40 flex items-center justify-center"
    :class="modal ? 'bg-black/50' : ''"
    @click="onBackdropClick"
  >
    <!-- Dialog window -->
    <div
      ref="dialogRef"
      class="relative bg-white shadow-xl rounded-lg flex flex-col"
      :class="[
        maximized ? 'w-screen h-screen' : 'min-w-[400px] max-w-3xl',
        $attrs.class
      ]"
      tabindex="-1"
      @keydown.esc="onEsc"
    >
      <!-- Header -->
      <div
        v-if="$slots.header"
        class="flex items-center justify-between border-b px-4 py-2"
      >
        <slot name="header" />
        <div class="flex gap-2 items-center">
          <button
            v-if="maximizable"
            class="p-1 hover:bg-gray-100 rounded"
            @click="toggleMaximize"
          >
            <Icon v-if="!maximized" class="i-ph-arrow-line-up-bold" />
            <Icon v-else class="i-ph-arrow-line-down-bold" />
          </button>
          <button
            v-if="closable"
            class="p-1 hover:bg-gray-100 rounded"
            @click="close"
          >
            <Icon class="i-ph-x-bold" />
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto px-4 py-2" :class="contentClass">
        <slot />
      </div>

      <!-- Footer -->
      <div v-if="$slots.footer" class="border-t px-4 py-2 flex justify-end">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = withDefaults(
  defineProps<{
    modelValue?: boolean
    visible?: boolean
    modal?: boolean
    closable?: boolean
    closeOnEscape?: boolean
    draggable?: boolean
    maximizable?: boolean
    contentClass?: string
  }>(),
  {
    modelValue: undefined,
    visible: false,
    modal: false,
    closable: true,
    closeOnEscape: true,
    draggable: false,
    maximizable: false,
    contentClass: ""
  }
)

const emit = defineEmits(["update:visible"])

const maximized = ref(false)
const dialogRef = ref<HTMLElement | null>(null)

const visible = ref(props.visible || props.modelValue || false)

watch(
  () => props.visible,
  (val) => {
    visible.value = val
  }
)
watch(
  () => props.modelValue,
  (val) => {
    if (val !== undefined) visible.value = val
  }
)

watch(visible, (val) => {
  emit("update:visible", val)
})

function close() {
  visible.value = false
}

function toggleMaximize() {
  maximized.value = !maximized.value
}

function onEsc(e: KeyboardEvent) {
  if (props.closeOnEscape && visible.value) {
    e.stopPropagation()
    close()
  }
}

function onBackdropClick(e: MouseEvent) {
  if (!props.modal && e.target === e.currentTarget && props.closable) {
    close()
  }
}

// optional: draggable support
let dragData: { x: number; y: number } | null = null

function startDrag(e: MouseEvent) {
  if (!props.draggable || !dialogRef.value) return
  dragData = { x: e.clientX, y: e.clientY }
  document.addEventListener("mousemove", onDrag)
  document.addEventListener("mouseup", stopDrag)
}

function onDrag(e: MouseEvent) {
  if (!dragData || !dialogRef.value) return
  const dx = e.clientX - dragData.x
  const dy = e.clientY - dragData.y
  const el = dialogRef.value
  el.style.transform = `translate(${dx}px, ${dy}px)`
}

function stopDrag() {
  dragData = null
  document.removeEventListener("mousemove", onDrag)
  document.removeEventListener("mouseup", stopDrag)
}

onMounted(() => {
  if (props.draggable && dialogRef.value) {
    dialogRef.value
      .querySelector(".border-b") // use header as handle
      ?.addEventListener("mousedown", startDrag)
  }
})
onBeforeUnmount(() => stopDrag())
</script>
