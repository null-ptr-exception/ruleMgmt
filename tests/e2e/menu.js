// Opening a tree node's menu. A scroll closes an open menu, and the scroll
// a click does by itself (to reach a node below the window) is seen by the
// page after the menu opened: the menu is gone before its item is clicked.
// So the node is brought into view first, and the page left to finish
// scrolling (two frames), before the click that opens the menu.

/** `target` scrolled into view, the page done scrolling. */
export async function intoView(page, target) {
  await target.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise(done => window.requestAnimationFrame(() => window.requestAnimationFrame(done))))
}

/** The right-click menu of a tree node (`node` a .ant-tree-treenode). */
export async function openMenu(page, node) {
  const target = node.locator('.ant-tree-node-content-wrapper')
  await intoView(page, target)
  await target.click({ button: 'right' })
}
