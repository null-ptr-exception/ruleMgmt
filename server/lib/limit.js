/**
 * At most `max` of the tasks passed through it run at once; the rest wait,
 * in the order they came. One limit is shared by every caller that uses it,
 * so it also holds across concurrent requests.
 *
 *   const limit = createLimit(4)
 *   const result = await limit(() => runSomething())
 */
export function createLimit(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { task, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }
  return task => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    next()
  })
}
