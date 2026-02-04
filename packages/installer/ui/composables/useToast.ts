import { deepEqual } from "fast-equals"
import { ref } from "vue"

export type NotificationType = "info" | "warning" | "success" | "error"
export interface NotificationData {
  title?: string
  type?: NotificationType
  severity?: NotificationType
  message?: string
  actions?: any[]
  actionsClass?: string
}

const messages = ref<
  {
    id: string | number
    type?: NotificationType
    timeout?: number
    progress: number
    order: number
    data: NotificationData
  }[]
>([])

const removeOne = (notificationId: string | number) => {
  messages.value =
    messages.value?.filter(({ id }) => id !== notificationId) || []
}

const removeAll = () => (messages.value = [])
const generateId = () => new Date().getTime()

const add = (
  data: NotificationData,
  options: {
    timeout?: number
  } = {}
) => {
  const timeout = typeof options.timeout !== "number" ? 3500 : options.timeout
  const messageId = generateId()

  const ind = messages.value.findIndex((item) => deepEqual(item.data, data))
  if (ind > -1) {
    messages.value.splice(ind, 1)
  }
  messages.value.push({
    id: messageId,
    type: data.type || data.severity,
    timeout,
    progress: 0,
    order: -1,
    data
  })
  if (messages.value.length > 7) {
    messages.value.splice(0, 1)
  }
  messages.value.forEach((n, index) => {
    n.order = messages.value.length - index
  })

  return messageId
}

export function useToast() {
  return { removeOne, removeAll, add, messages }
}
