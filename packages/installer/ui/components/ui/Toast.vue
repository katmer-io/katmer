<script setup lang="ts">
import { useToast } from "../../composables/useToast.ts"
import { ref, watch } from "vue"

const hover = ref(false)
let tInt: any

const toast = useToast()
const icons = {
  success: "i-ph-check-circle",
  error: "i-ph-x-circle",
  warning: "i-ph-warning-duotone",
  info: "i-ph-info-duotone"
}

function removeOne(id: string | number) {
  reset()
  toast.removeOne(id)
}

function reset() {
  if (tInt) {
    clearInterval(tInt)
    tInt = null
  }
  hover.value = false
}
function startTimer() {
  hover.value = false
  const n = toast.messages.value.at(-1)
  if (tInt) {
    reset()
  }
  if (n) {
    tInt = setInterval(() => {
      if (n) {
        if (n.timeout && !hover.value) {
          n.progress += n.timeout / 1000
        }
        if (n.timeout && n.progress >= 100) {
          removeOne(n.id)
        }
      }
    }, 100)
  }
}
watch(
  () => toast.messages.value.length,
  (v) => {
    startTimer()
    if (tInt && v <= 0) {
      reset()
    }
  },
  { flush: "sync" }
)
</script>

<template>
  <template v-for="message in toast.messages.value" :key="message.id">
    <div
      v-if="!!message"
      :style="{ marginBottom: `${message.order * 5 + 12}px` }"
      class="fixed bottom-0 right-3 z-[5555555555] flex max-w-md min-w-[275px] items-start rounded-md border p-4 shadow-md transition hover:shadow-lg"
      :class="{
        'bg-green-50 border-green-200 text-green-800':
          (message.type || message.severity) === 'success',
        'bg-red-50 border-red-200 text-red-800':
          (message.type || message.severity) === 'error',
        'bg-yellow-50 border-yellow-200 text-yellow-800':
          (message.type || message.severity) === 'warning',
        'bg-blue-50 border-blue-200 text-blue-800':
          (message.type || message.severity) === 'info'
      }"
      @click.prevent.stop=""
      @mouseover="reset"
      @mouseleave="startTimer"
    >
      <Icon
        v-if="message.type || message.severity"
        size="24"
        class="me-3"
        :color="message.type"
        :class="icons[message.type || message.severity]"
      />
      <div
        class="d-flex flex-column"
        style="word-break: break-word; color: black"
      >
        <h4 class="flex items-center me-8 font-bold">
          {{ message.data.title }}
        </h4>
        <div v-if="message.data.message" class="flex-none me-2">
          <ul v-if="Array.isArray(message.data.message)">
            <li
              v-for="message in message.data.message"
              v-once
              v-html="message"
            />
          </ul>
          <span v-else v-html="message.data.message" />
        </div>
      </div>

      <Spinner
        class="close-indicator ms-auto bg-transparent"
        size="32"
        :value="message.progress"
        @click="removeOne(message.id)"
      >
        <Icon
          class="p-2 i-ph-x-circle-duotone absolute top-1.5 left-1.5"
          @click.stop="removeOne(message.id)"
        />
      </Spinner>
    </div>
  </template>
</template>

<style scoped>
.alert {
  box-shadow: 0 0 4px -2px black;
  z-index: 5555555555;
  position: fixed;
  bottom: 0;
  right: 12px;
  padding: 12px 16px;
  border-radius: 2px;
  display: flex;
  align-items: center;
}
.close-indicator {
  color: rgba(0, 0, 0, 0.4);
}
.alert:hover .close-indicator {
  color: #000000;
}
</style>
