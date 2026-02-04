<script lang="ts" setup>
import { computed, ref } from "vue"

const selectedIndex = ref<number | null>(null)
const { tabs } = defineProps<{
  tabs: ({ key: string; title: string; icon?: string } | string)[]
}>()

const tabList = computed(() => {
  return tabs.map((t) => {
    return typeof t === "string" ? { key: t, title: t } : t
  })
})
</script>

<template>
  <div class="tabs tabs-lift bg-base-200 relative">
    <template v-for="(tab, index) in tabList">
      <label class="tab">
        <input
          type="radio"
          :value="index"
          :checked="selectedIndex === index"
          @click="selectedIndex = selectedIndex === index ? null : index"
        />
        <Icon v-if="tab.icon" class="me-2" :class="tab.icon" />
        {{ tab.title }}
      </label>
      <div
        class="tab-content border-base-300 bg-base-100 p-2 min-h-[300px] max-h-[300px] overflow-auto"
      >
        <slot :name="tab.key" />
      </div>
      <div
        v-if="selectedIndex === null && index < tabList.length - 1"
        class="divider divider-horizontal my-0 py-2 mx-0 w-0"
      />
    </template>
    <Button
      v-if="selectedIndex !== null"
      class="size-6 absolute end-2 top-2"
      icon="i-ph-x"
      @click="selectedIndex = null"
    />
  </div>
</template>

<style></style>
