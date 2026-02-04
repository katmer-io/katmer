<script setup>
const props = defineProps({
  context: Object,
  title: String,
  ignore: { type: Boolean, default: true }
})
</script>

<template>
  <h3
    class="mb-1 mt-2 inline-flex items-center justify-center text-md font-semibold"
  >
    {{ title || context.title }}
  </h3>
  <hr class="mb-3 mt-0" />
</template>
