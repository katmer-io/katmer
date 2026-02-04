<!-- Dropdown.vue -->
<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { PropType } from "vue"
import { createInput } from "@formkit/vue"

type Option = {
  label: string
  value: string | number | boolean
  disabled?: boolean
  hint?: string
}

type DaisySize = "xs" | "sm" | "md" | "lg"
type DaisyVariant =
  | "neutral"
  | "primary"
  | "secondary"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "error"

const props = defineProps({
  context: {
    type: Object as PropType<any>,
    required: true
  }
})

const ctx = computed(() => props.context)
const uid = computed(
  () => ctx.value.id ?? `fk-dd-${Math.random().toString(36).slice(2)}`
)
const isOpen = ref(false)

const label = computed<string | undefined>(() => ctx.value?.label)
const help = computed<string | undefined>(() => ctx.value?.help)
const placeholder = computed<string>(() => ctx.value?.placeholder ?? "Select…")
const disabled = computed<boolean>(
  () => !!(ctx.value?.disabled || ctx.value?.attrs?.disabled)
)
const required = computed<boolean>(() => !!ctx.value?.required)

const size = computed<DaisySize>(
  () => (ctx.value?.attrs?.size as DaisySize) ?? "md"
)
const variant = computed<DaisyVariant>(
  () => (ctx.value?.attrs?.variant as DaisyVariant) ?? "neutral"
)
const fullWidth = computed<boolean>(
  () => (ctx.value?.attrs?.fullWidth ?? true) !== false
)

const options = computed<Option[]>(() => {
  const raw = ctx.value?.attrs?.options ?? ctx.value?.options ?? []
  if (Array.isArray(raw)) return raw
  // support object map { value: label }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([value, label]) => ({
      value: isNaN(Number(value)) ? value : Number(value),
      label: String(label)
    }))
  }
  return []
})

const modelValue = computed(() => ctx.value?._value)

const selected = computed<Option | undefined>(() => {
  const v = modelValue.value
  return options.value.find((o) => o.value === v)
})

const buttonText = computed(() => selected.value?.label ?? placeholder.value)

const sizeClass = computed(() => {
  switch (size.value) {
    case "xs":
      return "btn-xs"
    case "sm":
      return "btn-sm"
    case "lg":
      return "btn-lg"
    case "md":
    default:
      return "btn-md"
  }
})

const emits = defineEmits(["change"])

const variantClass = computed(() => {
  switch (variant.value) {
    case "primary":
      return "btn-primary"
    case "secondary":
      return "btn-secondary"
    case "accent":
      return "btn-accent"
    case "info":
      return "btn-info"
    case "success":
      return "btn-success"
    case "warning":
      return "btn-warning"
    case "error":
      return "btn-error"
    case "neutral":
    default:
      return "btn-neutral"
  }
})

const rootClass = computed(() => [
  ctx.value.classes.control,
  "form-control",
  fullWidth.value ? "w-full" : "w-auto",
  disabled.value ? "opacity-70" : ""
])

const errorText = computed(() => {
  const v = ctx.value?.state?.validationVisible
  const msgs = ctx.value?.state?.messages
  if (!v || !msgs) return ""
  const first = Object.values(msgs)[0] as any
  return first?.value ?? ""
})

function close() {
  isOpen.value = false
}

function toggle() {
  if (disabled.value) return
  isOpen.value = !isOpen.value
}

function setValue(opt: Option) {
  if (disabled.value || opt.disabled) return
  ctx.value?.node?.input(opt.value)
  emits("change", opt.value)
  close()
}

// Close when value changes externally
watch(modelValue, () => close())
</script>

<template>
  <div :class="rootClass">
    <label v-if="label" class="label" :for="uid">
      <span class="label-text">
        {{ label }}<span v-if="required" class="ml-1 text-error">*</span>
      </span>
    </label>

    <button
      role="button"
      class="cursor-pointer"
      :class="[sizeClass, variantClass]"
      :popovertarget="uid"
      :style="`anchor-name:--anchor-${uid}`"
      :disabled="disabled"
    >
      <component
        :is="ctx.slots.activator"
        v-if="ctx.slots.activator"
        :disabled="disabled"
        :class="[sizeClass, variantClass]"
      />
      <template v-else>
        <span class="truncate">{{ buttonText }}</span>
        <svg
          class="ml-2 h-4 w-4 opacity-80"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M7 10l5 5 5-5"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </template>
    </button>

    <ul
      :id="uid"
      class="dropdown menu dropdown-bottom dropdown-end shadow text-base-content w-max max-h-72 overflow-auto rounded-box z-10 bg-base-100 p-2"
      :style="`position-anchor:--anchor-${uid}`"
      role="listbox"
      popover
      :aria-labelledby="uid"
    >
      <li v-if="!options.length" class="pointer-events-none opacity-70">
        <span>No options</span>
      </li>

      <li
        v-for="opt in options"
        :key="String(opt.value)"
        :class="[{ disabled: !!opt.disabled }]"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between"
          :class="[
            selected?.value === opt.value ? 'active' : '',
            opt.disabled ? 'opacity-60 pointer-events-none' : ''
          ]"
          role="option"
          :aria-selected="selected?.value === opt.value ? 'true' : 'false'"
          @click="setValue(opt)"
        >
          <span class="truncate">{{ opt.label }}</span>
          <span
            v-if="selected?.value === opt.value"
            class="ml-3 text-xs opacity-70"
            >✓</span
          >
        </button>

        <div v-if="opt.hint" class="px-4 pb-2 text-xs opacity-60">
          {{ opt.hint }}
        </div>
      </li>
    </ul>
  </div>

  <div v-if="help" class="mt-1 text-xs opacity-70">
    {{ help }}
  </div>

  <div v-if="errorText" class="mt-1 text-sm text-error">
    {{ errorText }}
  </div>
</template>
