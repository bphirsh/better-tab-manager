import { getLists, getOptions } from '../core/storage'
import type { TabList } from '../core/types'
import {
  openTabLists,
  storeAllTabs,
  storeAllTabsInAllWindows,
  storeLeftTabs,
  storeRightTabs,
  storeSelectedTabs,
  storeTabGroup,
  storeTwoSideTabs,
} from './tabs'

type MenuHandler = (listId?: string, target?: chrome.tabs.Tab) => Promise<unknown>

const actions: Record<string, MenuHandler> = {
  SHOW_TAB_LIST: () => openTabLists(),
  STORE_SELECTED: storeSelectedTabs,
  STORE_ALL: storeAllTabs,
  STORE_ALL_WINDOWS: () => storeAllTabsInAllWindows(),
  STORE_LEFT: storeLeftTabs,
  STORE_RIGHT: storeRightTabs,
  STORE_TWOSIDE: storeTwoSideTabs,
}

const createMenuTree = async (
  contexts: chrome.contextMenus.ContextType[],
  titledLists: TabList[],
  prefix: string,
  rootParentId?: string,
): Promise<void> => {
  const create = (props: chrome.contextMenus.CreateProperties) =>
    new Promise<void>(resolve => {
      chrome.contextMenus.create({
        ...props,
        id: prefix + props.id,
        parentId: props.parentId ? prefix + props.parentId : rootParentId,
      }, () => {
        void chrome.runtime.lastError
        resolve()
      })
    })
  if (prefix === '') await create({ id: 'SHOW_TAB_LIST', title: 'Open Better Tab Manager', contexts })
  await create({ id: 'STORE_SELECTED', title: 'Store selected tabs', contexts })
  await create({ id: 'STORE_GROUP', title: "Store this tab's group", contexts })
  await create({ id: 'STORE', title: 'Store tabs…', contexts })
  await create({ id: 'STORE.STORE_ALL', parentId: 'STORE', title: 'All tabs in this window', contexts })
  await create({ id: 'STORE.STORE_ALL_WINDOWS', parentId: 'STORE', title: 'All tabs in all windows', contexts })
  await create({ id: 'STORE.STORE_LEFT', parentId: 'STORE', title: 'Tabs to the left', contexts })
  await create({ id: 'STORE.STORE_RIGHT', parentId: 'STORE', title: 'Tabs to the right', contexts })
  await create({ id: 'STORE.STORE_TWOSIDE', parentId: 'STORE', title: 'Tabs on both sides', contexts })

  if (titledLists.length > 0) {
    await create({ id: 'TO_LIST', title: 'Store to list…', contexts })
    for (const list of titledLists.slice(0, 20)) {
      await create({ id: `TO_LIST|${list._id}`, parentId: 'TO_LIST', title: list.title, contexts })
      await create({ id: `TO_LIST.STORE_SELECTED|${list._id}`, parentId: `TO_LIST|${list._id}`, title: 'Selected tabs', contexts })
      await create({ id: `TO_LIST.STORE_ALL|${list._id}`, parentId: `TO_LIST|${list._id}`, title: 'All tabs in this window', contexts })
    }
  }
}

// Older browsers reject the tab context either synchronously or in the callback.
const createTabRoot = (contexts: chrome.contextMenus.ContextType[], visible: boolean) =>
  new Promise<boolean>(resolve => {
    try {
      chrome.contextMenus.create({ id: 'TAB', title: 'Better Tab Manager', contexts, visible }, () => {
        const error = chrome.runtime.lastError
        if (error) console.warn('Tab context menu unavailable:', error.message)
        resolve(!error)
      })
    } catch (error) {
      console.warn('Tab context menu unavailable:', error)
      resolve(false)
    }
  })

export const rebuildMenus = async () => {
  await chrome.contextMenus.removeAll()
  const opts = await getOptions()
  const contexts: chrome.contextMenus.ContextType[] = ['action']
  // when the page menu is on, always include links/images/selections too
  if (opts.pageContext) contexts.push('page', 'all')
  const titledLists = (await getLists()).filter(list => list.title)
  await createMenuTree(contexts, titledLists, '')
  // Chrome 150 adds "tab"; the project's pinned Chrome types predate it.
  const tabContexts = ['tab' as unknown as chrome.contextMenus.ContextType]
  const tabContextSupported = await createTabRoot(tabContexts, opts.tabContext)
  if (tabContextSupported) {
    if (opts.tabContext) await createMenuTree(tabContexts, titledLists, 'TAB.', 'TAB')
    else await chrome.contextMenus.remove('TAB')
  }
  await chrome.storage.session.set({ tabContextSupported })
}

export const handleMenuClick = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
  const menuItemId = String(info.menuItemId)
  const [path, listId] = menuItemId.split('|')
  const action = path.split('.').pop()!
  if (path.startsWith('TAB.')) {
    if (!tab) return
    if (action === 'STORE_GROUP') return storeTabGroup(tab, tab.windowId)
    if (action === 'STORE_ALL_WINDOWS') return storeAllTabsInAllWindows(tab.windowId)
    return actions[action]?.(listId, tab)
  }
  if (action === 'STORE_GROUP') return storeTabGroup(tab)
  const handler = actions[action]
  if (handler) return handler(listId)
}
