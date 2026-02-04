<template>
  <div
    class="flex flex-row items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/50"
  >
    <Icon
      class="i-ph-warning-bold text-amber-600 !size-6"
      :class="iconClass || context.iconClass"
    />
    <div
      class="font-normal"
      :class="contentClass || context.contentClass"
      v-html="content || context.content"
    />
  </div>
</template>

<script setup>
const props = defineProps({
  context: Object,
  content: String,
  contentClass: String,
  iconClass: String,
  ignore: { type: Boolean, default: true }
})
</script>

<style lang="scss"></style>
