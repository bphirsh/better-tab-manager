import { GROUP_TO_LIST_COLOR, placeTabsInGroup, splitByGroup } from '../core/grouping'
import { splitOpenable } from '../core/file-urls'
import { isStorableUrl, normalizeTab } from '../core/lists'
import { getLists, getOptions } from '../core/storage'
import type { TabGroupInfo, TabItem, TabList } from '../core/types'
import { appendTabsToGroupList, appendTabsToList, removeList, updateList } from './mutations'

const APP_URL = chrome.runtime.getURL('app.html')

const getAllInWindow = (windowId: number) => chrome.tabs.query({ windowId })

const getFocusedWindow = () => chrome.windows.getLastFocused({ windowTypes: ['normal'] })

/** Opens (or focuses) the list page, one per window. */
export const openTabLists = async (targetWindowId?: number) => {
  const { appTabIds = {} } = await chrome.storage.session.get('appTabIds')
  const windowId = targetWindowId ?? (await getFocusedWindow()).id!
  const existingId = appTabIds[String(windowId)]
  if (existingId != null) {
    try {
      const tab = await chrome.tabs.get(existingId)
      if (tab.windowId === windowId && tab.url?.startsWith(APP_URL)) {
        await chrome.tabs.update(tab.id!, { active: true })
        return
      }
    } catch {
      // tab was closed; fall through and create a new one
    }
  }
  const created = await chrome.tabs.create({ url: APP_URL, windowId })
  await chrome.storage.session.set({ appTabIds: { ...appTabIds, [windowId]: created.id } })
}

export const getSelectedTabs = () => chrome.tabs.query({ highlighted: true, currentWindow: true })

const getAllTabsInCurrentWindow = async () => {
  const win = await getFocusedWindow()
  return getAllInWindow(win.id!)
}

const groupTabsForStore = async (target?: chrome.tabs.Tab) => {
  const tabs = target ? await getAllInWindow(target.windowId) : await getAllTabsInCurrentWindow()
  const result = { left: [] as chrome.tabs.Tab[], right: [] as chrome.tabs.Tab[], inter: [] as chrome.tabs.Tab[], all: tabs }
  let currentIsRight = false
  for (const tab of tabs) {
    if (target && !target.highlighted ? tab.id === target.id : tab.highlighted) {
      currentIsRight = true
      result.inter.push(tab)
    } else if (currentIsRight) result.right.push(tab)
    else result.left.push(tab)
  }
  return { ...result, twoSide: result.left.concat(result.right) }
}

/** Looks up group title/color for every group the given tabs belong to. */
const getGroupInfoMap = async (tabs: chrome.tabs.Tab[]): Promise<Map<number, TabGroupInfo>> => {
  const map = new Map<number, TabGroupInfo>()
  if (!chrome.tabGroups) return map
  const groupIds = [...new Set(tabs.map(t => t.groupId).filter(id => id != null && id >= 0))]
  for (const id of groupIds) {
    try {
      const group = await chrome.tabGroups.get(id)
      map.set(id, { title: group.title ?? '', color: group.color })
    } catch {
      // group vanished mid-operation
    }
  }
  return map
}

const toTabItem = (tab: chrome.tabs.Tab, groups?: Map<number, TabGroupInfo>): TabItem =>
  normalizeTab({
    url: tab.url ?? '',
    title: tab.title ?? '',
    favIconUrl: tab.favIconUrl,
    pinned: tab.pinned,
    muted: tab.mutedInfo?.muted,
    group: tab.groupId != null && tab.groupId >= 0 ? groups?.get(tab.groupId) : undefined,
  })

export const storeTabs = async (tabs: chrome.tabs.Tab[], listId?: string) => {
  const opts = await getOptions()
  let storable = tabs.filter(t => t.url && !t.url.startsWith(chrome.runtime.getURL('')))
  if (opts.ignorePinned) storable = storable.filter(t => !t.pinned)
  if (opts.excludeIllegalURL) storable = storable.filter(t => isStorableUrl(t.url!))
  if (storable.length === 0) return
  const groups = await getGroupInfoMap(storable)
  const items = storable.map(t => toTabItem(t, groups))
  if (listId == null) {
    // named tab groups route to their own lists; the rest form an ordinary list
    const { byGroup, loose } = splitByGroup(items)
    for (const { group, tabs: groupTabs } of byGroup.values()) {
      await appendTabsToGroupList(group.title, GROUP_TO_LIST_COLOR[group.color] ?? '', groupTabs)
    }
    if (loose.length > 0) await appendTabsToList(undefined, loose)
  } else {
    await appendTabsToList(listId, items)
  }
  await chrome.tabs.remove(storable.map(t => t.id!))
}

/**
 * Applies the openListPage option before tabs close. With 'never' and a
 * store-everything operation, a fresh new-tab page keeps the window alive.
 */
const maybeOpenListPage = async (storingAll: boolean, windowId?: number) => {
  const opts = await getOptions()
  switch (opts.openListPage) {
    case 'always':
      return openTabLists(windowId)
    case 'all-stored':
      if (storingAll) return openTabLists(windowId)
      return
    case 'if-absent': {
      const targetWindowId = windowId ?? (await getFocusedWindow()).id!
      const tabs = await getAllInWindow(targetWindowId)
      if (!tabs.some(t => t.url?.startsWith(APP_URL))) return openTabLists(windowId)
      return
    }
    case 'never':
      if (storingAll) await chrome.tabs.create(windowId == null ? {} : { windowId })
      return
  }
}

export const storeSelectedTabs = async (listId?: string, target?: chrome.tabs.Tab) => {
  const allTabs = target ? await getAllInWindow(target.windowId) : await getAllTabsInCurrentWindow()
  const tabs = target
    ? allTabs.filter(tab => target.highlighted ? tab.highlighted : tab.id === target.id)
    : await getSelectedTabs()
  await maybeOpenListPage(tabs.length === allTabs.length, target?.windowId)
  return storeTabs(tabs, listId)
}

export const storeAllTabs = async (listId?: string, target?: chrome.tabs.Tab) => {
  const tabs = target ? await getAllInWindow(target.windowId) : await getAllTabsInCurrentWindow()
  await maybeOpenListPage(true, target?.windowId)
  return storeTabs(tabs, listId)
}

export const storeAllTabsInAllWindows = async (windowId?: number) => {
  const windows = await chrome.windows.getAll()
  await maybeOpenListPage(true, windowId)
  for (const win of windows) {
    const tabs = await getAllInWindow(win.id!)
    await storeTabs(tabs)
  }
}

const storeGrouped = async (which: 'left' | 'right' | 'twoSide', listId?: string, target?: chrome.tabs.Tab) => {
  const groups = await groupTabsForStore(target)
  if (target && groups[which].length === 0) return
  await maybeOpenListPage(false, target?.windowId)
  return storeTabs(groups[which], listId)
}

export const storeLeftTabs = (listId?: string, target?: chrome.tabs.Tab) => storeGrouped('left', listId, target)
export const storeRightTabs = (listId?: string, target?: chrome.tabs.Tab) => storeGrouped('right', listId, target)
export const storeTwoSideTabs = (listId?: string, target?: chrome.tabs.Tab) => storeGrouped('twoSide', listId, target)

/** Context-menu action: stores the clicked tab's whole group (or just the tab if ungrouped). */
export const storeTabGroup = async (tab?: chrome.tabs.Tab, windowId?: number) => {
  if (!tab) return
  const grouped =
    tab.groupId != null && tab.groupId >= 0
      ? await chrome.tabs.query({ groupId: tab.groupId, windowId: tab.windowId })
      : [tab]
  await maybeOpenListPage(false, windowId)
  return storeTabs(grouped)
}

/**
 * Puts restored tabs back into tab groups: consecutive tabs with the same
 * stored group cluster together, and each cluster joins an already-open group
 * with that name in the window (or creates it).
 */
const regroupTabs = async (created: { id: number; windowId?: number; group?: TabGroupInfo }[]) => {
  if (!chrome.tabGroups) return
  let cluster: number[] = []
  let current: TabGroupInfo | undefined
  let clusterWindow: number | undefined
  const flush = async () => {
    if (current && cluster.length > 0) await placeTabsInGroup(cluster, current, clusterWindow)
    cluster = []
  }
  for (const tab of created) {
    const sameGroup =
      tab.group && current && tab.group.title === current.title && tab.group.color === current.color
    if (!sameGroup) {
      await flush()
      current = tab.group
      clusterWindow = tab.windowId
    }
    if (tab.group) cluster.push(tab.id)
  }
  await flush()
}

export const restoreTabs = async (tabs: TabItem[], windowId?: number) => {
  const opts = await getOptions()
  let indexOffset = 0
  if (opts.restorePosition !== 'start') {
    const existing = windowId != null ? await getAllInWindow(windowId) : await getAllTabsInCurrentWindow()
    indexOffset = (existing.at(-1)?.index ?? -1) + 1
  }
  const created: { id: number; windowId?: number; group?: TabGroupInfo }[] = []
  for (const tab of tabs) {
    // one unopenable URL mustn't abort the rest of the restore
    try {
      const createdTab = await chrome.tabs.create({
        url: tab.url,
        pinned: tab.pinned,
        index: created.length + indexOffset,
        windowId,
      })
      if (tab.muted) await chrome.tabs.update(createdTab.id!, { muted: true })
      created.push({ id: createdTab.id!, windowId: createdTab.windowId, group: tab.group })
    } catch {
      /* skip it; the others still open */
    }
  }
  await regroupTabs(created)
}

/**
 * Opens a list's tabs. file:// tabs are held back when the user hasn't allowed
 * file-URL access (Chrome would reject them, and in a new window one bad URL
 * fails the whole window); they come back as `blocked` so callers can keep them
 * in the list and tell the user how to enable it.
 */
export const restoreList = async (
  list: TabList,
  { windowId, newWindow }: { windowId?: number; newWindow?: boolean } = {},
): Promise<{ blocked: TabItem[] }> => {
  const { openable, blocked } = await splitOpenable(list.tabs)
  if (openable.length === 0) return { blocked }
  // explicit request wins; otherwise the restorePosition option decides
  const openInNewWindow = newWindow ?? (await getOptions()).restorePosition === 'new-window'
  if (openInNewWindow) {
    const created = await chrome.windows.create({ url: openable.map(t => t.url) })
    const createdTabs: { id: number; windowId?: number; group?: TabGroupInfo }[] = []
    openable.forEach((tab, index) => {
      const target = created.tabs?.[index]
      if (!target) return
      if (tab.muted) chrome.tabs.update(target.id!, { muted: true })
      if (tab.pinned) chrome.tabs.update(target.id!, { pinned: true })
      createdTabs.push({ id: target.id!, windowId: created.id, group: tab.group })
    })
    await regroupTabs(createdTabs)
    return { blocked }
  }
  await restoreTabs(openable, windowId)
  return { blocked }
}

export const restoreLatestList = async () => {
  const lists = await getLists()
  const latest = lists.find(l => !l.pinned) ?? lists[0]
  if (!latest) return
  const { blocked } = await restoreList(latest)
  if (latest.pinned) return
  // keep any file:// tabs that couldn't open rather than deleting them with the list
  if (blocked.length) await updateList(latest._id, { tabs: blocked })
  else await removeList(latest._id)
}
