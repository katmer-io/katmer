<script setup lang="ts">
import { twMerge } from "tailwind-merge"
const props = defineProps<{
  size?: number | string
  icon?: string
}>()
const finalSize =
  props.size &&
  (`${Number(props.size)}` === props.size ? `${props.size}px` : props.size)
</script>
<template>
  <i
    :class="
      twMerge(
        'ic ic-mask flex-shrink-0',
        finalSize ? '' : 'size-5',
        icon,
        $attrs.class?.toString() || ''
      )
    "
    :style="finalSize ? { width: finalSize, height: finalSize } : {}"
    aria-hidden="true"
  />
</template>
