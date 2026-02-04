export function cloneInstance(orig: any) {
  return Object.assign(Object.create(Object.getPrototypeOf(orig)), orig)
}

export function isClass(obj: any) {
  if (typeof obj !== "function") return false
  const descriptor = Object.getOwnPropertyDescriptor(obj, "prototype")
  if (!descriptor) return false

  return !descriptor.writable
}
